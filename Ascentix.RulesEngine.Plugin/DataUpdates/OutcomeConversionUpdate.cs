using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Plugin.DataUpdates
{
    /// <summary>
    /// Data update 1: converts each action's retired On match / On no match setting (asx_ruleaction.asx_fireon)
    /// into outcomes and a Fires when tree, which is all the engine reads now. For every rule that still has an
    /// action with asx_fireon set, in rule id order:
    /// <list type="bullet">
    /// <item>Its outcomes (top-level groups that aren't "Run only when") get unique names: blank becomes
    /// "Outcome N" (smallest N free), a repeat (ignoring case) gets " (2)", " (3)"…, fitted to 100 characters.</item>
    /// <item>On match becomes a root ALL group with "outcome is true" per outcome (none: an empty ALL, which means
    /// always). On no match becomes a root ANY group with "outcome is false" per outcome; with no outcomes it could
    /// never fire, so the action is deactivated. asx_fireon is then cleared. An action that already has a tree
    /// keeps it; a tree this update started (stable ids) is completed.</item>
    /// </list>
    /// The rows are converted in place, past the draft guard, which is what a rule published before published
    /// versions existed (every rule from 0.0.0.1) runs from. A rule whose published version still has an active
    /// action with no tree fails as an item: only publishing from the Rule Builder replaces a published version.
    /// The cursor is the comma-separated ids of skipped (failed) rules: converted rules drop out of the query.
    /// </summary>
    public sealed class OutcomeConversionUpdate : IDataUpdate
    {
        public const string FireOn = "asx_fireon";
        private const int OnMatch = 1, OnNoMatch = 2, All = 1, Any = 2;
        public const int MaxOutcomeName = 100;

        public int Number => 1;
        public string Title => "Convert action conditions to outcomes";

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);
        private static readonly string ActionEntity = Q(SchemaNames.RuleAction.Entity);
        private static readonly string GroupEntity = Q(SchemaNames.ConditionGroup.Entity);
        private static readonly string TreeEntity = Q(SchemaNames.ActionConditionGroup.Entity);
        private static readonly string TestEntity = Q(SchemaNames.ActionConditionTest.Entity);

        public bool IsNeeded(IOrganizationService system)
        {
            var query = new QueryExpression(ActionEntity) { ColumnSet = new ColumnSet(false), TopCount = 1 };
            query.Criteria.AddCondition(FireOn, ConditionOperator.NotNull);
            return system.RetrieveMultiple(query).Entities.Count > 0;
        }

        public DataUpdateStep RunStep(DataUpdateContext context, string cursor, Func<bool> overBudget)
        {
            var skipped = Parse(cursor);
            var succeeded = 0;
            foreach (var ruleId in RulesToConvert(context.System))
            {
                if (skipped.Contains(ruleId)) continue;
                if (overBudget()) return new DataUpdateStep(cursor, false, succeeded);
                ConvertRule(context, ruleId);
                succeeded++;
            }
            return new DataUpdateStep(cursor, true, succeeded);
        }

        public string Skip(string cursor, string item)
        {
            var skipped = Parse(cursor);
            if (Guid.TryParse(item, out var id)) skipped.Add(id);
            return string.Join(",", skipped.OrderBy(g => g));
        }

        private static HashSet<Guid> Parse(string cursor) => new HashSet<Guid>(
            (cursor ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(Guid.Parse));

        /// <summary>Rules with an action whose asx_fireon is still set, in id order.</summary>
        private static List<Guid> RulesToConvert(IOrganizationService system)
        {
            var query = new QueryExpression(ActionEntity) { ColumnSet = new ColumnSet(Q(SchemaNames.RuleAction.Rule)) };
            query.Criteria.AddCondition(FireOn, ConditionOperator.NotNull);
            return RuleSnapshot.QueryAll(system, query)
                .Select(a => a.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleAction.Rule))?.Id)
                .Where(id => id.HasValue).Select(id => id.Value).Distinct().OrderBy(id => id).ToList();
        }

        private static void ConvertRule(DataUpdateContext context, Guid ruleId)
        {
            var system = context.System;
            var writer = context.Writer;
            var item = ruleId.ToString();
            var header = system.Retrieve("asx_rule", ruleId, new ColumnSet("asx_name", PublicationSchema.Pointer, PublicationSchema.DraftOf));
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) == null && PublishedVersionUnconverted(system, header))
                throw new DataUpdateItemException(item,
                    $"The published version of rule '{header.GetAttributeValue<string>("asx_name")}' still uses On match / On no match. " +
                    "Open the rule in the Rule Builder and publish it, then choose Retry failed items.");

            var outcomes = Outcomes(system, ruleId);
            var names = OutcomeNames(outcomes);

            var actions = new QueryExpression(ActionEntity) { ColumnSet = new ColumnSet("asx_name", FireOn) };
            actions.Criteria.AddCondition(Q(SchemaNames.RuleAction.Rule), ConditionOperator.Equal, ruleId);
            actions.Criteria.AddCondition(FireOn, ConditionOperator.NotNull);
            foreach (var action in RuleSnapshot.QueryAll(system, actions))
            {
                var fireOn = action.GetAttributeValue<OptionSetValue>(FireOn)?.Value;
                if (fireOn != OnMatch && fireOn != OnNoMatch)
                    throw new DataUpdateItemException(item,
                        $"Action '{action.GetAttributeValue<string>("asx_name")}' has an unknown On match / On no match value {fireOn}.");
                var update = new Entity(ActionEntity, action.Id) { [FireOn] = null };
                var rootId = RootId(system, action.Id);
                if (rootId.HasValue)
                {
                    // A tree from an interrupted run of this update is completed; anyone else's is kept as it is.
                    if (rootId.Value == StableId(action.Id + "/root")) BuildTree(system, writer, action.Id, fireOn == OnMatch, outcomes, rootExists: true);
                }
                else if (fireOn == OnMatch || outcomes.Count > 0)
                    BuildTree(system, writer, action.Id, fireOn == OnMatch, outcomes, rootExists: false);
                else
                    update[Q(SchemaNames.RuleAction.IsActive)] = false; // On no match with no outcomes never fired
                writer.Update(update);
            }

            // Renamed after the actions, as the script did: tests point at outcomes by id.
            foreach (var outcome in outcomes)
                if (names.TryGetValue(outcome.Id, out var name))
                    writer.Update(new Entity(GroupEntity, outcome.Id) { [Q(SchemaNames.PrimaryName)] = name });
        }

        /// <summary>The rule's published version has an active action with no Fires when tree (it never fires).</summary>
        private static bool PublishedVersionUnconverted(IOrganizationService system, Entity header)
        {
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) == null) return false;
            var snapshot = PublishedRules.Read(system, header);
            var withTree = new HashSet<string>(snapshot.Rows
                .Where(r => r.Entity == TreeEntity)
                .Select(r => r.Attributes.TryGetValue(Q(SchemaNames.ActionConditionGroup.RuleAction), out var v) ? v.Value : null)
                .Where(v => v != null), StringComparer.OrdinalIgnoreCase);
            return snapshot.Rows.Any(r => r.Entity == ActionEntity
                && !(r.Attributes.TryGetValue(Q(SchemaNames.RuleAction.IsActive), out var active) && active.Kind == "bool" && !bool.Parse(active.Value))
                && !withTree.Contains(r.Id.ToString()));
        }

        /// <summary>Top-level groups that aren't "Run only when" (a null flag reads as false, as in the engine), oldest first.</summary>
        private static List<Entity> Outcomes(IOrganizationService system, Guid ruleId)
        {
            var query = new QueryExpression(GroupEntity) { ColumnSet = new ColumnSet(Q(SchemaNames.PrimaryName), Q(SchemaNames.ConditionGroup.IsExecutionCondition), "createdon") };
            query.Criteria.AddCondition(Q(SchemaNames.ConditionGroup.Rule), ConditionOperator.Equal, ruleId);
            query.Criteria.AddCondition(Q(SchemaNames.ConditionGroup.ParentConditionGroup), ConditionOperator.Null);
            return RuleSnapshot.QueryAll(system, query)
                .Where(g => !g.GetAttributeValue<bool>(Q(SchemaNames.ConditionGroup.IsExecutionCondition)))
                .OrderBy(g => g.GetAttributeValue<DateTime>("createdon")).ThenBy(g => g.Id).ToList();
        }

        /// <summary>New names for the outcomes that need one, by outcome id. Names compare trimmed and ignoring case.</summary>
        public static Dictionary<Guid, string> OutcomeNames(IReadOnlyList<Entity> outcomes)
        {
            string NameOf(Entity o) => (o.GetAttributeValue<string>(Q(SchemaNames.PrimaryName)) ?? "").Trim();
            var taken = new HashSet<string>(outcomes.Select(NameOf).Where(n => n.Length > 0), StringComparer.OrdinalIgnoreCase);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var renames = new Dictionary<Guid, string>();
            foreach (var outcome in outcomes)
            {
                var name = NameOf(outcome);
                string fresh;
                if (name.Length == 0)
                {
                    var n = 1;
                    while (taken.Contains("Outcome " + n)) n++;
                    fresh = "Outcome " + n;
                }
                else if (!seen.Add(name))
                {
                    var k = 2;
                    while (taken.Contains(Fit(name, $" ({k})"))) k++;
                    fresh = Fit(name, $" ({k})");
                }
                else continue;
                taken.Add(fresh);
                seen.Add(fresh);
                renames[outcome.Id] = fresh;
            }
            return renames;
        }

        private static string Fit(string name, string suffix)
        {
            var room = MaxOutcomeName - suffix.Length;
            return (name.Length > room ? name.Substring(0, room).TrimEnd() : name) + suffix;
        }

        private static Guid? RootId(IOrganizationService system, Guid actionId)
        {
            var query = new QueryExpression(TreeEntity) { ColumnSet = new ColumnSet(false), TopCount = 1 };
            query.Criteria.AddCondition(Q(SchemaNames.ActionConditionGroup.RuleAction), ConditionOperator.Equal, actionId);
            query.Criteria.AddCondition(Q(SchemaNames.ActionConditionGroup.ParentGroup), ConditionOperator.Null);
            return system.RetrieveMultiple(query).Entities.FirstOrDefault()?.Id;
        }

        private static void BuildTree(IOrganizationService system, IOrganizationService writer, Guid actionId, bool onMatch,
            IReadOnlyList<Entity> outcomes, bool rootExists)
        {
            var rootId = StableId(actionId + "/root");
            var have = new HashSet<Guid>();
            if (rootExists)
            {
                var tests = new QueryExpression(TestEntity) { ColumnSet = new ColumnSet(false) };
                tests.Criteria.AddCondition(Q(SchemaNames.ActionConditionTest.Group), ConditionOperator.Equal, rootId);
                have.UnionWith(RuleSnapshot.QueryAll(system, tests).Select(t => t.Id));
            }
            else
            {
                writer.Create(new Entity(TreeEntity, rootId)
                {
                    [Q(SchemaNames.ActionConditionGroup.RuleAction)] = new EntityReference(ActionEntity, actionId),
                    [Q(SchemaNames.ActionConditionGroup.LogicalOperator)] = new OptionSetValue(onMatch ? All : Any),
                    [Q(SchemaNames.ActionConditionGroup.Order)] = 1,
                });
            }
            var order = 0;
            foreach (var outcome in outcomes)
            {
                order++;
                var testId = StableId(actionId + "/test/" + outcome.Id);
                if (have.Contains(testId)) continue;
                writer.Create(new Entity(TestEntity, testId)
                {
                    [Q(SchemaNames.ActionConditionTest.Group)] = new EntityReference(TreeEntity, rootId),
                    [Q(SchemaNames.ActionConditionTest.Outcome)] = new EntityReference(GroupEntity, outcome.Id),
                    [Q(SchemaNames.ActionConditionTest.Expected)] = onMatch,
                    [Q(SchemaNames.ActionConditionTest.Order)] = order,
                });
            }
        }

        /// <summary>
        /// The same id for the same tree row on every run, and the same as the conversion script this update replaced gave it,
        /// so a tree that script or an interrupted run of this update started is completed rather than duplicated.
        /// </summary>
        public static Guid StableId(string key)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(("asx-multi-outcome-2026-10/" + key).ToLowerInvariant()));
                var bytes = new byte[16];
                Array.Copy(hash, bytes, 16);
                return new Guid(bytes);
            }
        }
    }
}
