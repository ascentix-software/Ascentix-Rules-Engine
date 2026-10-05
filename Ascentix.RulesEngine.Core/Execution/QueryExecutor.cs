using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    // ─── Query Executor ───────────────────────────────────────────────────────

    /// <summary>
    /// Walks the execution plan level by level, executing queries and populating the cache.
    /// LookupTable nodes read a field off the parent record and retrieve the related record.
    /// ChildTable nodes query WHERE ChildLinkField IN (parentIds).
    ///
    /// Pushdown: each entry may demand filtered variants, each one the same parent-scoped fetch
    /// with a pushed predicate appended, cached under (nodeId, variantKey). An entry may also skip its
    /// unfiltered fetch entirely when the planner proved nothing consumes it. The traversal cap
    /// counts rows RETURNED per fetch (post-pushdown), never rows scanned: a selective pushed
    /// filter over a multi-million-row collection returns its matches and passes; an evaluation
    /// that genuinely materializes more than the cap fails with a named error rather than
    /// timing out or silently truncating.
    /// </summary>
    public class QueryExecutor
    {
        private const int LookupChunkSize = 2000;
        private const int ChildChunkSize = 2000;
        private const int PageSize = 5000;

        /// <summary>Max rows a single node-variant fetch may RETURN per root evaluation. Fails,
        /// never truncates: truncated evaluation is a silently-wrong RowCount.</summary>
        public const int MaxReturnedRowsPerVariant = 25000;

        private readonly IOrganizationService _service;
        private readonly QueryResultCache _cache;
        private readonly TableConfigTree _tree;
        private readonly Ascentix.RulesEngine.Core.Diagnostics.RunDiagnostics _diagnostics;
        private readonly DateTime _utcNow;
        private readonly bool _rootIsNew;
        private InFlightBatch _inFlight;
        private readonly RunFetchStore _store;

        // What Execute used to keep per call, now one per root of the group.
        private sealed class RootState
        {
            public Entity Root;
            public QueryResultCache Cache;
            public NewRecordStamp Stamp;
            public string Table;
        }

        /// <param name="utcNow">The run's evaluation instant (date placeholders anchored on "now"
        /// never reach here; it feeds <see cref="NewRecordStamp"/>).</param>
        /// <param name="rootIsNew">True on Create: the root's createdon/modifiedon bind to utcNow.</param>
        /// <param name="store">The run's shared reads (null: fetch everything, as one bucket alone).</param>
        public QueryExecutor(
            IOrganizationService service,
            QueryResultCache cache,
            TableConfigTree tree,
            Ascentix.RulesEngine.Core.Diagnostics.RunDiagnostics diagnostics = null,
            DateTime utcNow = default,
            bool rootIsNew = false,
            RunFetchStore store = null)
        {
            _service = service;
            _cache = cache;
            _tree = tree ?? TableConfigTree.Empty;
            _diagnostics = diagnostics;
            _utcNow = utcNow;
            _rootIsNew = rootIsNew;
            _store = store;
        }

        public void Execute(Entity triggeringRecord, QueryExecutionPlan plan)
            => Execute(triggeringRecord, plan, null);

        /// <param name="inFlight">The Create/Update/Delete still in flight at pre-operation, or
        /// null for a read with nothing pending. Every fetch of that same table is reconciled
        /// against it (see <see cref="InFlightReconciler"/>) so a traversal that re-reads the
        /// triggering table does not evaluate against a superseded database state.</param>
        public void Execute(Entity triggeringRecord, QueryExecutionPlan plan, InFlightBatch inFlight) =>
            Run(new List<RootState> { new RootState { Root = triggeringRecord, Cache = _cache } }, plan, inFlight);

        /// <summary>Executes the plan for a whole group of roots at once: each node is fetched over the
        /// union of the roots' scopes (once per distinct bound filter) and split back per root, then
        /// reconciled, capped and stored per root exactly as <see cref="Execute(Entity, QueryExecutionPlan, InFlightBatch)"/>
        /// does for one. Returns one new cache per root, in root order. A group of one issues exactly
        /// Execute's fetches.</summary>
        public IReadOnlyList<QueryResultCache> ExecuteMany(IList<Entity> roots, QueryExecutionPlan plan, InFlightBatch inFlight)
        {
            var states = roots.Select(r => new RootState { Root = r, Cache = new QueryResultCache(_tree) }).ToList();
            Run(states, plan, inFlight);
            return states.Select(s => s.Cache).ToList();
        }

        private void Run(List<RootState> states, QueryExecutionPlan plan, InFlightBatch inFlight)
        {
            _inFlight = inFlight;
            foreach (var state in states) Seed(state);

            // Two phases. Every unfiltered fetch first, level by level: they scope every child
            // fetch (parent ids) and they are what a date placeholder binds from. Then every
            // pushed variant, each scoped by its parent's unfiltered ids. An anchor record is
            // therefore always loaded before any variant binds, whatever the relative depth of
            // the anchor and the filtered node, and no ordering cycle can exist.
            foreach (var level in plan.Levels)
                foreach (var entry in level)
                    if (entry.DemandsUnfiltered) ExecuteNode(states, entry, null);

            foreach (var level in plan.Levels)
                foreach (var entry in level)
                    foreach (var variant in entry.Variants ?? Enumerable.Empty<NodeQueryVariant>())
                        if (variant != null && !string.IsNullOrEmpty(variant.Key)) ExecuteNode(states, entry, variant);
        }

        // Seed EVERY root node with the triggering record. The runner loads the config nodes
        // of every rule it evaluates into one dictionary, and two published rules on the same
        // table may live in two different config trees (two RootTable nodes). Seeding only the
        // first root left the other tree's children fetching against an empty parent set (0
        // rows), so its RowCount/EXISTS/filtered conditions reach confident, wrong verdicts,
        // and WHICH tree loses depends on dictionary order.
        private void Seed(RootState state)
        {
            var triggeringTable = state.Root?.LogicalName;
            var roots = triggeringTable == null ? _tree.Roots : _tree.RootsForTable(triggeringTable);
            if (roots.Count == 0)
                roots = _tree.Roots;
            if (roots.Count == 0)
                throw new InvalidPluginExecutionException("Table Config tree has no root node to seed.");
            foreach (var root in roots)
                state.Cache.Store(root.Id, new List<Entity> { state.Root });
            state.Table = triggeringTable ?? roots[0].TableLogicalName;
            state.Stamp = _rootIsNew ? new NewRecordStamp(state.Root, _utcNow) : null;
        }

        private void ExecuteNode(List<RootState> states, ExecutionPlanEntry entry, NodeQueryVariant variant)
        {
            switch (entry.Node.ConfigType)
            {
                case TableConfigType.LookupTable:
                    ExecuteLookupNode(states, entry, variant);
                    break;
                case TableConfigType.ChildTable:
                    ExecuteChildTableNode(states, entry, variant);
                    break;
            }
        }

        // One scope per root with something to fetch, grouped by the root's bound filter (null
        // filter = "" key). Roots whose scope is empty store an empty result now, without a fetch.
        private Dictionary<string, List<(RootState State, List<Guid> Scope)>> GroupByFilter(
            List<RootState> states, ExecutionPlanEntry entry, NodeQueryVariant variant, Func<RootState, List<Guid>> scopeOf)
        {
            var groups = new Dictionary<string, List<(RootState, List<Guid>)>>(StringComparer.Ordinal);
            foreach (var state in states)
            {
                var scope = scopeOf(state);
                if (scope.Count == 0)
                {
                    StoreVariant(state.Cache, entry, variant, new List<Entity>());
                    continue;
                }
                var key = FilterXml(variant, state) ?? "";
                if (!groups.TryGetValue(key, out var members)) groups[key] = members = new List<(RootState, List<Guid>)>();
                members.Add((state, scope));
            }
            return groups;
        }

        private static List<Guid> Union(List<(RootState State, List<Guid> Scope)> members)
        {
            var seen = new HashSet<Guid>();
            var union = new List<Guid>();
            foreach (var member in members)
                foreach (var id in member.Scope)
                    if (seen.Add(id)) union.Add(id);
            return union;
        }

        // For each scope id, the members (by index) whose scope holds it. Built before the fetch so the
        // cap can count each member's rows as pages arrive; null for a group of one, which owns every
        // fetched row.
        private static Dictionary<Guid, List<int>> Owners(List<(RootState State, List<Guid> Scope)> members)
        {
            if (members.Count == 1) return null;
            var owners = new Dictionary<Guid, List<int>>();
            for (var m = 0; m < members.Count; m++)
                foreach (var id in members[m].Scope)
                {
                    if (!owners.TryGetValue(id, out var list)) owners[id] = list = new List<int>();
                    if (list.Count == 0 || list[list.Count - 1] != m) list.Add(m);
                }
            return owners;
        }

        // Rows for each member: a row belongs to every member whose scope holds its key. A group of
        // one keeps the fetched rows as they are (a copy of the list, as before). That shortcut is the
        // general path for one member: the fetch's IN condition is that member's scope, so every
        // fetched row's key is in it, and keeping the rows as fetched (same order, same list) is
        // exactly the old behaviour.
        private static List<List<Entity>> Split(List<(RootState State, List<Guid> Scope)> members,
            Dictionary<Guid, List<int>> owners, List<Entity> rows, Func<Entity, Guid?> keyOf)
        {
            if (members.Count == 1) return new List<List<Entity>> { new List<Entity>(rows) };
            var split = members.Select(_ => new List<Entity>()).ToList();
            foreach (var row in rows)
            {
                var key = keyOf(row);
                if (key == null || !owners.TryGetValue(key.Value, out var list)) continue;
                foreach (var m in list) split[m].Add(row);
            }
            return split;
        }

        // Counts a page's rows for every member that owns them and fails as soon as one member passes
        // the cap: the first member, in root order, over it, with today's message naming its root
        // table. A group of one counts every row, exactly as the single-root fetch always did.
        private static void CountAndCap(TableConfig node, List<(RootState State, List<Guid> Scope)> members,
            Dictionary<Guid, List<int>> owners, Func<Entity, Guid?> keyOf, IList<Entity> page, int[] counts)
        {
            if (owners == null)
            {
                counts[0] += page.Count;
                EnforceCap(node, counts[0], members[0].State.Table);
                return;
            }
            foreach (var row in page)
            {
                var key = keyOf(row);
                if (key == null || !owners.TryGetValue(key.Value, out var list)) continue;
                foreach (var m in list) counts[m]++;
            }
            for (var m = 0; m < members.Count; m++)
                EnforceCap(node, counts[m], members[m].State.Table);
        }

        // One filter group: fetch once over the union of the members' scopes (through the run's
        // store), capping each member as pages arrive, then split the rows back and, per member,
        // cap, reconcile and store. fetchRows(union, filterXml, columns, onPage) reads the rows and
        // calls onPage with each page or chunk as it arrives.
        private void FetchGroup(ExecutionPlanEntry entry, NodeQueryVariant variant, string filterKey,
            List<(RootState State, List<Guid> Scope)> members, FetchKind kind, HashSet<string> columns,
            Func<Entity, Guid?> keyOf,
            Func<List<Guid>, string, HashSet<string>, Action<IList<Entity>>, List<Entity>> fetchRows)
        {
            var union = Union(members);
            var filterXml = filterKey.Length == 0 ? null : filterKey;
            var owners = Owners(members);
            var shared = Fetch(kind, entry.Node, union, filterXml, columns, cols =>
            {
                // Fresh counts per read: the store may re-read the same fetch wider.
                var counts = new int[members.Count];
                return fetchRows(union, filterXml, cols, page => CountAndCap(entry.Node, members, owners, keyOf, page, counts));
            });
            var split = Split(members, owners, shared, keyOf);
            for (var m = 0; m < members.Count; m++)
            {
                // Again per member: rows served from the run's store skipped the counting above (for
                // example a group of one whose scope matches a larger group's stored fetch).
                EnforceCap(entry.Node, split[m].Count, members[m].State.Table);
                // After every chunk/page, so the record is matched against the whole result and
                // the parent scope is the full set the fetch covered, not one chunk of it.
                InFlightReconciler.Apply(split[m], entry.Node, _inFlight, members[m].Scope);
                StoreVariant(members[m].State.Cache, entry, variant, split[m]);
            }
        }

        private void ExecuteLookupNode(List<RootState> states, ExecutionPlanEntry entry, NodeQueryVariant variant)
        {
            var idAttr = entry.Node.LookupTargetIdAttribute;
            var parentKey = Guid.Parse(entry.ParentCacheKey);
            var groups = GroupByFilter(states, entry, variant, state =>
            {
                // Distinct target ids from the parents' lookup references.
                var targetIds = new List<Guid>();
                var seen = new HashSet<Guid>();
                foreach (var parent in state.Cache.Get(parentKey))
                {
                    if (!parent.Contains(entry.Node.LookupColumnLogicalName)) continue;
                    var lookupRef = parent.GetAttributeValue<EntityReference>(entry.Node.LookupColumnLogicalName);
                    if (lookupRef == null) continue;
                    if (seen.Add(lookupRef.Id)) targetIds.Add(lookupRef.Id);
                }
                // Same check, same point as before (after reading the parents, whatever the count).
                if (string.IsNullOrWhiteSpace(idAttr))
                    throw new InvalidPluginExecutionException(
                        $"LookupTable node '{entry.Node.TableLogicalName}' (id {entry.Node.Id}) is missing " +
                        "asx_lookuptargetidattribute, which is required to batch-load lookup targets.");
                return targetIds;
            });

            foreach (var group in groups)
                FetchGroup(entry, variant, group.Key, group.Value, FetchKind.Lookup, null, row => row.Id,
                    (union, filterXml, _, onPage) => FetchLookupRows(entry.Node, idAttr, union, filterXml, onPage));
        }

        private List<Entity> FetchLookupRows(TableConfig node, string idAttr, List<Guid> targetIds, string filterXml, Action<IList<Entity>> onPage)
        {
            var resolved = new List<Entity>();
            foreach (var chunk in Chunk(targetIds, LookupChunkSize))
            {
                var fetchXml = BuildLookupFetch(node.TableLogicalName, idAttr, chunk, filterXml);
                var results = _service.RetrieveMultiple(new FetchExpression(fetchXml));
                _diagnostics?.RecordRetrieveMultiple(node.Id, node.TableLogicalName, results.Entities.Count);
                resolved.AddRange(results.Entities);
                onPage(results.Entities);
            }
            return resolved;
        }

        private static string BuildLookupFetch(string entity, string idAttribute, IList<Guid> ids, string pushedFilterXml)
        {
            var inValues = string.Join("", ids.Select(id => $"<value>{id}</value>"));
            return $@"
                <fetch>
                  <entity name='{entity}'>
                    <all-attributes />
                    <filter>
                      <condition attribute='{idAttribute}' operator='in'>
                        {inValues}
                      </condition>
                      {pushedFilterXml}
                    </filter>
                  </entity>
                </fetch>";
        }

        private static IEnumerable<IList<Guid>> Chunk(IList<Guid> source, int size)
        {
            for (var i = 0; i < source.Count; i += size)
                yield return source.Skip(i).Take(size).ToList();
        }

        private void ExecuteChildTableNode(List<RootState> states, ExecutionPlanEntry entry, NodeQueryVariant variant)
        {
            var parentKey = Guid.Parse(entry.ParentCacheKey);
            var groups = GroupByFilter(states, entry, variant, state => state.Cache.GetIds(parentKey).ToList());
            var columns = _store == null ? entry.Columns : _store.ColumnsFor(_service, entry.Node, entry.Columns);

            foreach (var group in groups)
                FetchGroup(entry, variant, group.Key, group.Value, FetchKind.Child, columns,
                    row => row.GetAttributeValue<EntityReference>(entry.Node.ChildLinkField)?.Id,
                    (union, filterXml, cols, onPage) => FetchChildRows(entry.Node, union, filterXml, cols, onPage));
        }

        private List<Entity> FetchChildRows(TableConfig node, List<Guid> parentIds, string filterXml, HashSet<string> columns, Action<IList<Entity>> onPage)
        {
            var all = new List<Entity>();
            foreach (var chunk in Chunk(parentIds, ChildChunkSize))
            {
                var page = 1;
                string cookie = null;
                while (true)
                {
                    var fetchXml = BuildChildTableFetch(node, chunk, page, cookie, filterXml, PageSize, columns);
                    var results = _service.RetrieveMultiple(new FetchExpression(fetchXml));
                    _diagnostics?.RecordRetrieveMultiple(node.Id, node.TableLogicalName, results.Entities.Count);
                    all.AddRange(results.Entities);
                    onPage(results.Entities);
                    if (!results.MoreRecords) break;
                    page++;
                    cookie = results.PagingCookie;
                }
            }
            return all;
        }

        // Through the run's store when there is one; the stored list is shared, so callers copy it.
        private List<Entity> Fetch(FetchKind kind, TableConfig node, List<Guid> scope, string filterXml,
            HashSet<string> columns, Func<HashSet<string>, List<Entity>> fetch) =>
            _store == null
                ? fetch(columns)
                : _store.GetOrFetch(_service, kind, node, scope, filterXml, columns, fetch);

        private static string BuildChildTableFetch(TableConfig node, IList<Guid> parentIds, int page, string cookie, string pushedFilterXml, int pageSize = PageSize, HashSet<string> columns = null)
        {
            var inValues = string.Join("", parentIds.Select(id => $"<value>{id}</value>"));
            var cookieAttr = string.IsNullOrEmpty(cookie)
                ? ""
                : $" paging-cookie='{System.Security.SecurityElement.Escape(cookie)}'";
            // Pruned width when the collector proved the read set; full width otherwise.
            var attributes = columns == null
                ? "<all-attributes />"
                : string.Join("", columns.OrderBy(c => c, StringComparer.Ordinal)
                    .Select(c => $"<attribute name='{System.Security.SecurityElement.Escape(c)}' />"));
            return $@"
                <fetch count='{pageSize}' page='{page}'{cookieAttr}>
                  <entity name='{node.TableLogicalName}'>
                    {attributes}
                    <filter>
                      <condition attribute='{node.ChildLinkField}'
                                 operator='in'>
                        {inValues}
                      </condition>
                      {pushedFilterXml}
                    </filter>
                  </entity>
                </fetch>";
        }

        /// <summary>The pushed filter for this fetch: none for the unfiltered fetch; the stored
        /// fragment for a plain variant; for a variant with date placeholders, the filter bound
        /// to this root. A placeholder that cannot bind (anchor record or value missing, or out of
        /// the calendar) relaxes to no constraint (<see cref="PushedFilter.Bind"/>): the variant
        /// keeps its other pushed criteria, or is fetched without a pushed filter when none is
        /// left. Either way a superset, re-filtered in memory.</summary>
        private string FilterXml(NodeQueryVariant variant, RootState state)
        {
            if (variant == null) return null;
            if (variant.Filter == null || !variant.Filter.HasBindings) return variant.FilterFetchXml;
            return variant.Filter.Bind(b => BindDate(b, state))?.ToFetchXml();
        }

        private string BindDate(DateBinding binding, RootState state)
        {
            if (!DateExprSpec.TryParse(binding.Payload, out var spec) || !spec.AnchorNode.HasValue) return null;
            if (!state.Cache.Has(spec.AnchorNode.Value)) return null;
            try
            {
                if (!DateExprEvaluator.TryEvaluateFromRaw(spec, null, state.Cache, _tree, _utcNow,
                        "pushed date filter", out var value, state.Stamp))
                    return null;
                return binding.Format(value);
            }
            // A non-date anchor column is reported by the in-memory filter; an interval that
            // leaves the calendar is reported at publish (STRUCT_INVALID_DATEEXPR).
            catch (InvalidPluginExecutionException) { return null; }
            catch (ArgumentOutOfRangeException) { return null; }
        }

        private static void StoreVariant(QueryResultCache cache, ExecutionPlanEntry entry, NodeQueryVariant variant, List<Entity> rows)
        {
            if (variant == null) cache.Store(entry.Node.Id, rows);
            else cache.Store(entry.Node.Id, variant.Key, rows);
        }

        private static void EnforceCap(TableConfig node, int returnedSoFar, string table)
        {
            if (returnedSoFar <= MaxReturnedRowsPerVariant) return;
            throw new InvalidPluginExecutionException(OperationStatus.Failed,
                $"Rules Engine: rule evaluation on '{table}' needed more than " +
                $"{MaxReturnedRowsPerVariant:N0} matching rows from '{node.TableLogicalName}' " +
                $"(config node {node.Id}). Narrow the rule's filters (server-side filterable " +
                "criteria; see Beta Limitations) or reduce the collection.");
        }
    }
}
