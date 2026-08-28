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
        private string _rootTable;
        private InFlightBatch _inFlight;

        public QueryExecutor(
            IOrganizationService service,
            QueryResultCache cache,
            TableConfigTree tree,
            Ascentix.RulesEngine.Core.Diagnostics.RunDiagnostics diagnostics = null)
        {
            _service = service;
            _cache = cache;
            _tree = tree ?? TableConfigTree.Empty;
            _diagnostics = diagnostics;
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

            foreach (var level in plan.Levels)
            {
                foreach (var entry in level)
                {
                    switch (entry.Node.ConfigType)
                    {
                        case TableConfigType.LookupTable:
                            ExecuteLookupNode(entry);
                            break;
                        case TableConfigType.ChildTable:
                            ExecuteChildTableNode(entry);
                            break;
                    }
                }
            }
        }

        private void ExecuteLookupNode(ExecutionPlanEntry entry)
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

            foreach (var variant in DemandedFetches(entry))
            {
                if (targetIds.Count == 0)
                {
                    StoreVariant(entry, variant, new List<Entity>());
                    continue;
                }

                var resolved = new List<Entity>();
                foreach (var chunk in Chunk(targetIds, LookupChunkSize))
                {
                    var fetchXml = BuildLookupFetch(entry.Node.TableLogicalName, idAttr, chunk, variant?.FilterFetchXml);
                    var results = _service.RetrieveMultiple(new FetchExpression(fetchXml));
                    _diagnostics?.RecordRetrieveMultiple(entry.Node.Id, entry.Node.TableLogicalName, results.Entities.Count);
                    resolved.AddRange(results.Entities);
                    EnforceCap(entry.Node, resolved.Count);
                }

                InFlightReconciler.Apply(resolved, entry.Node, _inFlight, targetIds);
                StoreVariant(entry, variant, resolved);
            }
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

        private void ExecuteChildTableNode(ExecutionPlanEntry entry)
        {
            var parentIds = _cache.GetIds(Guid.Parse(entry.ParentCacheKey)).ToList();

            foreach (var variant in DemandedFetches(entry))
            {
                if (!parentIds.Any())
                {
                    StoreVariant(entry, variant, new List<Entity>());
                    continue;
                }

                var all = new List<Entity>();
                foreach (var chunk in Chunk(parentIds, ChildChunkSize))
                {
                    var page = 1;
                    string cookie = null;
                    while (true)
                    {
                        var fetchXml = BuildChildTableFetch(entry.Node, chunk, page, cookie, variant?.FilterFetchXml, PageSize, entry.Columns);
                        var results = _service.RetrieveMultiple(new FetchExpression(fetchXml));
                        _diagnostics?.RecordRetrieveMultiple(entry.Node.Id, entry.Node.TableLogicalName, results.Entities.Count);
                        all.AddRange(results.Entities);
                        EnforceCap(entry.Node, all.Count);
                        if (!results.MoreRecords) break;
                        page++;
                        cookie = results.PagingCookie;
                    }
                }

                // After every chunk/page, so the record is matched against the whole result and
                // the parent scope is the full set the fetch covered, not one chunk of it.
                InFlightReconciler.Apply(all, entry.Node, _inFlight, parentIds);
                StoreVariant(entry, variant, all);
            }
        }

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

        /// <summary>The fetches this entry demands, in execution order: the unfiltered fetch
        /// (null variant) unless the planner proved it unconsumed, then each pushed variant.</summary>
        private static IEnumerable<NodeQueryVariant> DemandedFetches(ExecutionPlanEntry entry)
        {
            if (entry.DemandsUnfiltered) yield return null;
            foreach (var v in entry.Variants ?? Enumerable.Empty<NodeQueryVariant>())
                if (v != null && !string.IsNullOrEmpty(v.Key)) yield return v;
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
