using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>Per-table breakdown of what a sync/removal did. Step names, not ids,
    /// so the JSON is pasteable into an issue report.</summary>
    public sealed class TableSyncDetail
    {
        public string Table { get; set; }
        public List<string> Created { get; } = new List<string>();
        public List<string> Updated { get; } = new List<string>();
        public List<string> Deleted { get; } = new List<string>();
        public List<string> Deactivated { get; } = new List<string>();

        public bool IsEmpty =>
            Created.Count == 0 && Updated.Count == 0 && Deleted.Count == 0 && Deactivated.Count == 0;
    }

    /// <summary>What asx_SyncSteps reports back.</summary>
    public sealed class SyncOutcome
    {
        public int TablesProcessed { get; set; }
        public List<TableSyncDetail> Tables { get; } = new List<TableSyncDetail>();

        public int StepsCreated => Tables.Sum(t => t.Created.Count);
        public int StepsUpdated => Tables.Sum(t => t.Updated.Count);
        public int StepsDeleted => Tables.Sum(t => t.Deleted.Count);
        public int DeactivatedStepsFound => Tables.Sum(t => t.Deactivated.Count);

        /// <summary>Only tables where something happened (or a deactivated step was seen).</summary>
        public string DetailsJson()
        {
            var sb = new StringBuilder("[");
            var first = true;
            foreach (var t in Tables.Where(t => !t.IsEmpty))
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append("{\"table\":").Append(Quote(t.Table));
                AppendList(sb, "created", t.Created);
                AppendList(sb, "updated", t.Updated);
                AppendList(sb, "deleted", t.Deleted);
                AppendList(sb, "deactivated", t.Deactivated);
                sb.Append("}");
            }
            return sb.Append("]").ToString();
        }

        private static void AppendList(StringBuilder sb, string key, List<string> values)
        {
            sb.Append(",\"").Append(key).Append("\":[");
            for (var i = 0; i < values.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(Quote(values[i]));
            }
            sb.Append("]");
        }

        private static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var c in s ?? string.Empty)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append("\"").ToString();
        }
    }

    /// <summary>
    /// The asx_SyncSteps mechanics. Sync is the existing StepPlanner→StepReconciler path
    /// iterated over every table that either has rules or has engine-owned steps (the
    /// second set catches orphans); it introduces no second reconciliation authority.
    /// Deactivated steps are reported, never re-enabled: the emergency-stop promise.
    /// RemoveAll deletes every engine-owned step (deactivated included) for pre-uninstall
    /// cleanup. Fail-fast: both operations are idempotent, so retry after a fault is free.
    /// </summary>
    public static class StepSyncService
    {
        public static SyncOutcome Sync(
            IEnumerable<string> ruleTables, IStepSyncEnvironment env, Func<string, DesiredSteps> plan)
        {
            var tables = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var t in ruleTables ?? Enumerable.Empty<string>())
                if (!string.IsNullOrWhiteSpace(t)) tables.Add(t);
            foreach (var step in env.GetAllEngineSteps())
            {
                var t = TableFromStepName(step.Name);
                if (t != null) tables.Add(t);
            }

            var outcome = new SyncOutcome { TablesProcessed = tables.Count };
            foreach (var table in tables)
            {
                var recorder = new RecordingEnvironment(env);
                StepReconciler.Reconcile(recorder, table, plan(table));
                outcome.Tables.Add(recorder.ToDetail(table));
            }
            return outcome;
        }

        public static SyncOutcome RemoveAll(IStepSyncEnvironment env)
        {
            var byTable = new Dictionary<string, TableSyncDetail>(StringComparer.OrdinalIgnoreCase);
            var steps = env.GetAllEngineSteps();
            foreach (var step in steps.OrderBy(s => s.Name, StringComparer.Ordinal))
            {
                env.DeleteStep(step.Id);
                var table = TableFromStepName(step.Name) ?? step.Name;
                if (!byTable.TryGetValue(table, out var detail))
                    byTable[table] = detail = new TableSyncDetail { Table = table };
                detail.Deleted.Add(step.Name);
            }

            var outcome = new SyncOutcome { TablesProcessed = byTable.Count };
            outcome.Tables.AddRange(byTable.Values.OrderBy(d => d.Table, StringComparer.OrdinalIgnoreCase));
            return outcome;
        }

        /// <summary>"Ascentix.RulesEngine: {table} {message}" → table; table logical names
        /// cannot contain spaces, so the last space splits unambiguously. Null when the
        /// name is not the engine convention.</summary>
        public static string TableFromStepName(string stepName)
        {
            const string prefix = DataverseRegistrationEnvironment.StepNamePrefix;
            if (stepName == null || !stepName.StartsWith(prefix, StringComparison.Ordinal)) return null;
            var rest = stepName.Substring(prefix.Length);
            var split = rest.LastIndexOf(' ');
            return split > 0 ? rest.Substring(0, split) : null;
        }

        /// <summary>Delegates to the real environment while recording what the reconciler
        /// did as step names (ids resolved via the GetEngineSteps result it served).</summary>
        private sealed class RecordingEnvironment : IRegistrationEnvironment
        {
            private readonly IRegistrationEnvironment _inner;
            private readonly Dictionary<Guid, string> _names = new Dictionary<Guid, string>();
            private readonly List<string> _created = new List<string>();
            private readonly List<string> _updated = new List<string>();
            private readonly List<string> _deleted = new List<string>();
            private readonly List<string> _deactivated = new List<string>();

            public RecordingEnvironment(IRegistrationEnvironment inner) { _inner = inner; }

            public bool SupportsMessage(string messageName, string tableLogicalName) =>
                _inner.SupportsMessage(messageName, tableLogicalName);

            public List<RegisteredStep> GetEngineSteps(string tableLogicalName)
            {
                var steps = _inner.GetEngineSteps(tableLogicalName);
                foreach (var s in steps)
                {
                    _names[s.Id] = s.Name ?? s.Id.ToString();
                    if (!s.IsActive) _deactivated.Add(s.Name ?? s.Id.ToString());
                }
                return steps;
            }

            public void CreateStep(StepRegistration registration)
            {
                _inner.CreateStep(registration);
                _created.Add(DataverseRegistrationEnvironment.StepName(
                    registration.TableLogicalName, registration.MessageName));
            }

            public void UpdateFilteringAttributes(Guid stepId, string filteringAttributes)
            {
                _inner.UpdateFilteringAttributes(stepId, filteringAttributes);
                _updated.Add(NameOf(stepId));
            }

            public void DeleteStep(Guid stepId)
            {
                _inner.DeleteStep(stepId);
                _deleted.Add(NameOf(stepId));
            }

            private string NameOf(Guid id) => _names.TryGetValue(id, out var n) ? n : id.ToString();

            public TableSyncDetail ToDetail(string table)
            {
                var detail = new TableSyncDetail { Table = table };
                detail.Created.AddRange(_created);
                detail.Updated.AddRange(_updated);
                detail.Deleted.AddRange(_deleted);
                detail.Deactivated.AddRange(_deactivated);
                return detail;
            }
        }
    }
}
