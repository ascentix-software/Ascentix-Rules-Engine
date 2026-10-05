using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>The record being saved: an update of it is applied to the in-flight Target in place.</summary>
    public sealed class RootRecord
    {
        public RootRecord(string table, Guid id) { Table = table; Id = id; }
        public string Table { get; }
        public Guid Id { get; }
    }

    /// <summary>One row the change set writes, merged from one or more intents.</summary>
    public sealed class ChangeSetWrite
    {
        private readonly List<WriteIntent> _sources = new List<WriteIntent>();

        internal ChangeSetWrite(WriteOperation operation, string table, Guid id, RuleEvaluationContext context, int firstSeen)
        {
            Operation = operation; Table = table; Id = id; Context = context; FirstSeen = firstSeen;
        }

        public WriteOperation Operation { get; internal set; }
        public string Table { get; }
        /// <summary>Guid.Empty only for a Create whose intent carried no id (the platform assigns one).</summary>
        public Guid Id { get; }
        public RuleEvaluationContext Context { get; }
        public Dictionary<string, object> Values { get; } = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

        internal Dictionary<string, object> Loaded { get; } = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        internal bool AlwaysWrite { get; set; }
        internal int FirstSeen { get; }
        internal void Add(WriteIntent intent) => _sources.Add(intent);
        internal void AddSourcesFrom(ChangeSetWrite other) => _sources.AddRange(other._sources);

        /// <summary>The first contributing action's name, or its id when it has none: error messages.</summary>
        public string ActionLabel
        {
            get
            {
                var first = _sources.FirstOrDefault();
                if (first == null) return "";
                return string.IsNullOrWhiteSpace(first.SourceActionName) ? first.SourceActionId.ToString() : first.SourceActionName;
            }
        }
    }

    /// <summary>The writes of one operation on one table under one evaluation context.</summary>
    public sealed class ChangeSetBatch
    {
        internal ChangeSetBatch(WriteOperation operation, string table, RuleEvaluationContext context, IReadOnlyList<ChangeSetWrite> writes)
        {
            Operation = operation; Table = table; Context = context; Writes = writes;
        }

        public WriteOperation Operation { get; }
        public string Table { get; }
        public RuleEvaluationContext Context { get; }
        public IReadOnlyList<ChangeSetWrite> Writes { get; }
    }

    /// <summary>
    /// Every write of ONE evaluated record, merged and ordered. Pure and deterministic: no service
    /// calls. Merge key (evaluation context, table, id): update + update → one update, the later
    /// action (by action order, then resolution order) winning per column; update + delete → delete;
    /// creates never merge. A merged update that is not always-write is dropped when every value
    /// equals the loaded value (<see cref="WriteValueComparer"/>); an unknown loaded value counts as
    /// changed. An update of the record being saved is collected into <see cref="RootInPlaceValues"/>
    /// and never becomes a batch. Batches: creates, then updates, then deletes, each grouped per
    /// (table, context) in first-seen order.
    /// </summary>
    public sealed class ChangeSet
    {
        private static readonly WriteOperation[] Phases = { WriteOperation.Create, WriteOperation.Update, WriteOperation.Delete };

        private readonly Dictionary<WriteIntent, ChangeSetWrite> _writeOf = new Dictionary<WriteIntent, ChangeSetWrite>();
        private readonly HashSet<ChangeSetWrite> _unchanged = new HashSet<ChangeSetWrite>();

        private readonly Dictionary<ChangeSetWrite, List<Guid>> _records = new Dictionary<ChangeSetWrite, List<Guid>>();

        /// <summary>The records whose change sets fed this combined write (<see cref="Combine"/>), in
        /// record order; empty for a write this set does not hold or a set built by ForRecord/Build.</summary>
        public IReadOnlyList<Guid> RecordsOf(ChangeSetWrite write) =>
            write != null && _records.TryGetValue(write, out var ids) ? (IReadOnlyList<Guid>)ids : new Guid[0];

        private void Own(ChangeSetWrite write, Guid recordId)
        {
            if (!_records.TryGetValue(write, out var ids)) _records[write] = ids = new List<Guid>();
            if (ids.Count == 0 || ids[ids.Count - 1] != recordId) ids.Add(recordId);
        }

        private ChangeSet() { }

        public IReadOnlyList<ChangeSetBatch> Batches { get; private set; }
        /// <summary>Merged values for the record being saved; empty when none.</summary>
        public IReadOnlyDictionary<string, object> RootInPlaceValues { get; private set; }
        /// <summary>True when at least one update targeted the record being saved.</summary>
        public bool HasRootInPlace { get; private set; }
        public int Creates { get; private set; }
        public int Updates { get; private set; }
        public int Deletes { get; private set; }
        public int Unchanged { get; private set; }
        /// <summary>Intents folded into another write: each update/delete that joined a row another
        /// intent already wrote, plus every in-place update of the saved record after the first.
        /// Creates never merge.</summary>
        public int Merged { get; private set; }
        public int WriteCount => Creates + Updates + Deletes;

        /// <summary>True when the intent's merged write was dropped by the no-op skip.</summary>
        public bool IsUnchanged(WriteIntent intent) =>
            intent != null && _writeOf.TryGetValue(intent, out var write) && _unchanged.Contains(write);

        /// <summary>The change set of one evaluated record's fired actions.</summary>
        public static ChangeSet ForRecord(RecordEvaluationResult record, RootRecord rootInPlace = null) =>
            Build((record?.FiredActions ?? new List<FiredActionResult>()).SelectMany(a => a.AllWriteIntents()),
                rootInPlace, record?.RecordId);

        /// <param name="rootInPlace">The record being saved when an in-flight Target exists; null otherwise
        /// (Run page, asx_ApplyRules, the dry run), in which case its update is an ordinary update.</param>
        /// <param name="evaluatedRecordId">The id an update/delete without a TargetId writes to (a
        /// root-targeted intent resolved without an id).</param>
        public static ChangeSet Build(IEnumerable<WriteIntent> intents, RootRecord rootInPlace = null, Guid? evaluatedRecordId = null)
        {
            var cs = new ChangeSet();
            var ordered = (intents ?? Enumerable.Empty<WriteIntent>())
                .Where(i => i != null)
                .Select((intent, seq) => new { intent, seq })
                .OrderBy(x => x.intent.SourceActionOrder).ThenBy(x => x.seq)
                .Select(x => x.intent)
                .ToList();

            var creates = new List<ChangeSetWrite>();
            var byKey = new Dictionary<string, ChangeSetWrite>(StringComparer.OrdinalIgnoreCase);
            var rootValues = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            var seen = 0;
            var merged = 0; var rootIntents = 0;

            foreach (var intent in ordered)
            {
                seen++;
                var values = intent.Values ?? new Dictionary<string, object>();

                if (intent.Operation == WriteOperation.Create)
                {
                    var create = new ChangeSetWrite(WriteOperation.Create, intent.TargetTable, intent.TargetId ?? Guid.Empty, intent.Context, seen);
                    foreach (var kv in values) create.Values[kv.Key] = kv.Value;
                    create.Add(intent);
                    cs._writeOf[intent] = create;
                    creates.Add(create);
                    continue;
                }

                var id = intent.TargetId ?? evaluatedRecordId ?? Guid.Empty;
                if (intent.Operation == WriteOperation.Update && IsRoot(intent, id, rootInPlace))
                {
                    cs.HasRootInPlace = true;
                    rootIntents++;
                    foreach (var kv in values) rootValues[kv.Key] = kv.Value;
                    continue;
                }

                var key = $"{(int)intent.Context}|{intent.TargetTable}|{id}";
                if (!byKey.TryGetValue(key, out var write))
                {
                    write = new ChangeSetWrite(intent.Operation, intent.TargetTable, id, intent.Context, seen);
                    byKey[key] = write;
                }
                else
                {
                    merged++;
                }
                write.Add(intent);
                cs._writeOf[intent] = write;

                if (intent.Operation == WriteOperation.Delete) { write.Operation = WriteOperation.Delete; continue; }
                if (write.Operation == WriteOperation.Delete) continue; // an update of a deleted row is moot

                foreach (var kv in values)
                {
                    write.Values[kv.Key] = kv.Value;
                    if (intent.LoadedValues != null && intent.LoadedValues.TryGetValue(kv.Key, out var loaded)
                        && !write.Loaded.ContainsKey(kv.Key))
                        write.Loaded[kv.Key] = loaded;
                }
                write.AlwaysWrite |= intent.AlwaysWrite;
            }

            // A delete of the saved record wins over its in-place update.
            if (rootInPlace != null && byKey.Values.Any(w => w.Operation == WriteOperation.Delete && w.Id == rootInPlace.Id
                    && string.Equals(w.Table, rootInPlace.Table, StringComparison.OrdinalIgnoreCase)))
            {
                rootValues.Clear();
                cs.HasRootInPlace = false;
            }

            foreach (var write in byKey.Values.Where(w => w.Operation == WriteOperation.Update && !w.AlwaysWrite))
                if (write.Values.All(kv => write.Loaded.TryGetValue(kv.Key, out var loaded) && WriteValueComparer.AreEqual(kv.Value, loaded)))
                    cs._unchanged.Add(write);

            cs.SetBatches(creates.Concat(byKey.Values.Where(w => !cs._unchanged.Contains(w))).ToList());
            cs.RootInPlaceValues = rootValues;
            cs.Unchanged = cs._unchanged.Count;
            cs.Merged = merged + Math.Max(0, rootIntents - 1);
            return cs;
        }

        // Batches: creates, then updates, then deletes, each grouped per (table, context) in first-seen order.
        private void SetBatches(List<ChangeSetWrite> sendable)
        {
            var batches = new List<ChangeSetBatch>();
            foreach (var phase in Phases)
                foreach (var group in sendable.Where(w => w.Operation == phase).OrderBy(w => w.FirstSeen)
                             .GroupBy(w => (Table: (w.Table ?? "").ToLowerInvariant(), w.Context)))
                    batches.Add(new ChangeSetBatch(phase, group.First().Table, group.Key.Context, group.ToList()));
            Batches = batches;
            Creates = sendable.Count(w => w.Operation == WriteOperation.Create);
            Updates = sendable.Count(w => w.Operation == WriteOperation.Update);
            Deletes = sendable.Count(w => w.Operation == WriteOperation.Delete);
        }

        /// <summary>
        /// Several records' change sets as one, in record order (a Rule Run page writes a group of
        /// records at once). Each set is already merged and has its unchanged writes dropped
        /// (<see cref="ForRecord"/>); across records the same rules apply: update + update of a row
        /// → one update, the later record winning per column; update + delete → delete; an update of a
        /// deleted row is moot; creates never merge; repeated deletes of a row collapse to one.
        /// <see cref="RecordsOf"/> names the records behind each combined write. Unchanged and Merged
        /// add up the records' own counts plus the writes merged across records. Never has root-in-place
        /// values (a run page has no in-flight Target).
        /// </summary>
        public static ChangeSet Combine(IReadOnlyList<(Guid RecordId, ChangeSet Set)> records)
        {
            var cs = new ChangeSet();
            var creates = new List<ChangeSetWrite>();
            var byKey = new Dictionary<string, ChangeSetWrite>(StringComparer.OrdinalIgnoreCase);
            var seen = 0;
            var merged = 0;
            var unchanged = 0;

            foreach (var (recordId, set) in records ?? new (Guid, ChangeSet)[0])
            {
                if (set == null) continue;
                unchanged += set.Unchanged;
                merged += set.Merged;
                foreach (var batch in set.Batches)
                    foreach (var source in batch.Writes)
                    {
                        seen++;
                        if (source.Operation == WriteOperation.Create)
                        {
                            var create = new ChangeSetWrite(WriteOperation.Create, source.Table, source.Id, source.Context, seen);
                            foreach (var kv in source.Values) create.Values[kv.Key] = kv.Value;
                            create.AddSourcesFrom(source);
                            creates.Add(create);
                            cs.Own(create, recordId);
                            continue;
                        }

                        var key = $"{(int)source.Context}|{source.Table}|{source.Id}";
                        if (!byKey.TryGetValue(key, out var write))
                            byKey[key] = write = new ChangeSetWrite(source.Operation, source.Table, source.Id, source.Context, seen);
                        else
                            merged++;
                        write.AddSourcesFrom(source);
                        cs.Own(write, recordId);

                        if (source.Operation == WriteOperation.Delete) { write.Operation = WriteOperation.Delete; continue; }
                        if (write.Operation == WriteOperation.Delete) continue; // an update of a deleted row is moot
                        foreach (var kv in source.Values) write.Values[kv.Key] = kv.Value;
                    }
            }

            cs.SetBatches(creates.Concat(byKey.Values).ToList());
            cs.RootInPlaceValues = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            cs.Unchanged = unchanged;
            cs.Merged = merged;
            return cs;
        }

        private static bool IsRoot(WriteIntent intent, Guid id, RootRecord root) =>
            root != null && (intent.RootTargeted
                || (root.Id != Guid.Empty && id == root.Id && string.Equals(intent.TargetTable, root.Table, StringComparison.OrdinalIgnoreCase)));
    }
}
