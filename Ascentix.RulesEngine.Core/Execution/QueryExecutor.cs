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
        private NewRecordStamp _stamp;
        private string _rootTable;
        private InFlightBatch _inFlight;
        private readonly RunFetchStore _store;

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
        public void Execute(Entity triggeringRecord, QueryExecutionPlan plan, InFlightBatch inFlight)
        {
            _inFlight = inFlight;

            // Seed EVERY root node with the triggering record. The runner loads the config nodes
            // of every rule it evaluates into one dictionary, and two published rules on the same
            // table may live in two different config trees (two RootTable nodes). Seeding only the
            // first root left the other tree's children fetching against an empty parent set (0
            // rows), so its RowCount/EXISTS/filtered conditions reach confident, wrong verdicts,
            // and WHICH tree loses depends on dictionary order.
            var triggeringTable = triggeringRecord?.LogicalName;
            var roots = triggeringTable == null ? _tree.Roots : _tree.RootsForTable(triggeringTable);
            if (roots.Count == 0)
                roots = _tree.Roots;
            if (roots.Count == 0)
                throw new InvalidPluginExecutionException("Table Config tree has no root node to seed.");
            foreach (var root in roots)
                _cache.Store(root.Id, new List<Entity> { triggeringRecord });
            _rootTable = triggeringTable ?? roots[0].TableLogicalName;

            _stamp = _rootIsNew ? new NewRecordStamp(triggeringRecord, _utcNow) : null;

            // Two phases. Every unfiltered fetch first, level by level: they scope every child
            // fetch (parent ids) and they are what a date placeholder binds from. Then every
            // pushed variant, each scoped by its parent's unfiltered ids. An anchor record is
            // therefore always loaded before any variant binds, whatever the relative depth of
            // the anchor and the filtered node, and no ordering cycle can exist.
            foreach (var level in plan.Levels)
                foreach (var entry in level)
                    if (entry.DemandsUnfiltered) ExecuteNode(entry, null);

            foreach (var level in plan.Levels)
                foreach (var entry in level)
                    foreach (var variant in entry.Variants ?? Enumerable.Empty<NodeQueryVariant>())
                        if (variant != null && !string.IsNullOrEmpty(variant.Key)) ExecuteNode(entry, variant);
        }

        private void ExecuteNode(ExecutionPlanEntry entry, NodeQueryVariant variant)
        {
            switch (entry.Node.ConfigType)
            {
                case TableConfigType.LookupTable:
                    ExecuteLookupNode(entry, variant);
                    break;
                case TableConfigType.ChildTable:
                    ExecuteChildTableNode(entry, variant);
                    break;
            }
        }

        private void ExecuteLookupNode(ExecutionPlanEntry entry, NodeQueryVariant variant)
        {
            var parentResults = _cache.Get(Guid.Parse(entry.ParentCacheKey));

            // Distinct target ids from the parents' lookup references.
            var targetIds = new List<Guid>();
            var seen = new HashSet<Guid>();
            foreach (var parent in parentResults)
            {
                if (!parent.Contains(entry.Node.LookupColumnLogicalName)) continue;
                var lookupRef = parent.GetAttributeValue<EntityReference>(entry.Node.LookupColumnLogicalName);
                if (lookupRef == null) continue;
                if (seen.Add(lookupRef.Id)) targetIds.Add(lookupRef.Id);
            }

            var idAttr = entry.Node.LookupTargetIdAttribute;
            if (string.IsNullOrWhiteSpace(idAttr))
                throw new InvalidPluginExecutionException(
                    $"LookupTable node '{entry.Node.TableLogicalName}' (id {entry.Node.Id}) is missing " +
                    "asx_lookuptargetidattribute, which is required to batch-load lookup targets.");

            if (targetIds.Count == 0)
            {
                StoreVariant(entry, variant, new List<Entity>());
                return;
            }

            var filterXml = FilterXml(variant);
            var shared = Fetch(FetchKind.Lookup, entry.Node, targetIds, filterXml, null,
                _ => FetchLookupRows(entry.Node, idAttr, targetIds, filterXml));
            var resolved = new List<Entity>(shared);

            InFlightReconciler.Apply(resolved, entry.Node, _inFlight, targetIds);
            StoreVariant(entry, variant, resolved);
        }

        private List<Entity> FetchLookupRows(TableConfig node, string idAttr, List<Guid> targetIds, string filterXml)
        {
            var resolved = new List<Entity>();
            foreach (var chunk in Chunk(targetIds, LookupChunkSize))
            {
                var fetchXml = BuildLookupFetch(node.TableLogicalName, idAttr, chunk, filterXml);
                var results = _service.RetrieveMultiple(new FetchExpression(fetchXml));
                _diagnostics?.RecordRetrieveMultiple(node.Id, node.TableLogicalName, results.Entities.Count);
                resolved.AddRange(results.Entities);
                EnforceCap(node, resolved.Count);
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

        private void ExecuteChildTableNode(ExecutionPlanEntry entry, NodeQueryVariant variant)
        {
            var parentIds = _cache.GetIds(Guid.Parse(entry.ParentCacheKey)).ToList();
            if (!parentIds.Any())
            {
                StoreVariant(entry, variant, new List<Entity>());
                return;
            }

            var filterXml = FilterXml(variant);
            var columns = _store == null ? entry.Columns : _store.ColumnsFor(_service, entry.Node, entry.Columns);
            var shared = Fetch(FetchKind.Child, entry.Node, parentIds, filterXml, columns,
                cols => FetchChildRows(entry.Node, parentIds, filterXml, cols));
            var all = new List<Entity>(shared);

            // After every chunk/page, so the record is matched against the whole result and
            // the parent scope is the full set the fetch covered, not one chunk of it.
            InFlightReconciler.Apply(all, entry.Node, _inFlight, parentIds);
            StoreVariant(entry, variant, all);
        }

        private List<Entity> FetchChildRows(TableConfig node, List<Guid> parentIds, string filterXml, HashSet<string> columns)
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
                    EnforceCap(node, all.Count);
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
        private string FilterXml(NodeQueryVariant variant)
        {
            if (variant == null) return null;
            if (variant.Filter == null || !variant.Filter.HasBindings) return variant.FilterFetchXml;
            return variant.Filter.Bind(BindDate)?.ToFetchXml();
        }

        private string BindDate(DateBinding binding)
        {
            if (!DateExprSpec.TryParse(binding.Payload, out var spec) || !spec.AnchorNode.HasValue) return null;
            if (!_cache.Has(spec.AnchorNode.Value)) return null;
            try
            {
                if (!DateExprEvaluator.TryEvaluateFromRaw(spec, null, _cache, _tree, _utcNow,
                        "pushed date filter", out var value, _stamp))
                    return null;
                return binding.Format(value);
            }
            // A non-date anchor column is reported by the in-memory filter; an interval that
            // leaves the calendar is reported at publish (STRUCT_INVALID_DATEEXPR).
            catch (InvalidPluginExecutionException) { return null; }
            catch (ArgumentOutOfRangeException) { return null; }
        }

        private void StoreVariant(ExecutionPlanEntry entry, NodeQueryVariant variant, List<Entity> rows)
        {
            if (variant == null) _cache.Store(entry.Node.Id, rows);
            else _cache.Store(entry.Node.Id, variant.Key, rows);
        }

        private void EnforceCap(TableConfig node, int returnedSoFar)
        {
            if (returnedSoFar <= MaxReturnedRowsPerVariant) return;
            throw new InvalidPluginExecutionException(OperationStatus.Failed,
                $"Rules Engine: rule evaluation on '{_rootTable}' needed more than " +
                $"{MaxReturnedRowsPerVariant:N0} matching rows from '{node.TableLogicalName}' " +
                $"(config node {node.Id}). Narrow the rule's filters (server-side filterable " +
                "criteria; see Beta Limitations) or reduce the collection.");
        }
    }
}
