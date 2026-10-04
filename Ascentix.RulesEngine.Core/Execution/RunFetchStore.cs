using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>Which shape of traversal fetch a stored entry answers.</summary>
    public enum FetchKind { Child, Lookup }

    /// <summary>
    /// What one engine run has already read from Dataverse, shared by every bucket of that run.
    /// RuleBuckets makes one bucket per published revision, and each bucket used to fetch the
    /// rows it traverses on its own, so a save under 100 rules read the same collection about
    /// 50 times. A run makes no writes before its buckets are evaluated, so what one bucket
    /// read stays true for the rest of the run.
    ///
    /// A fetch is keyed on what is actually read: the service (User and System context are
    /// different objects and never share), the kind, table and link column (never the node id:
    /// two revisions can define one node id differently), the scope ids and the bound pushed
    /// filter. Columns are not part of the key. The runner registers every bucket's column
    /// demand first (<see cref="DemandColumns"/>), and requesters ask for the combined set
    /// (<see cref="ColumnsFor"/>), so a later request is covered by what is stored. A request
    /// that is not covered re-reads with both sets and replaces the entry (FetchesWidened,
    /// expected 0).
    ///
    /// Stored rows are the raw database answer, before in-flight reconciliation. They are
    /// shared read-only: a requester copies the list, and InFlightReconciler copies a row
    /// before it overlays it.
    /// </summary>
    public sealed class RunFetchStore
    {
        private sealed class Stored
        {
            public List<Entity> Rows;
            public HashSet<string> Columns; // null = full width
        }

        private sealed class RootRead
        {
            public readonly HashSet<string> Columns = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public bool AllColumns;
            public Dictionary<Guid, Entity> Rows;
        }

        private readonly RunDiagnostics _diagnostics;
        private readonly List<IOrganizationService> _services = new List<IOrganizationService>();
        private readonly Dictionary<string, Stored> _fetches = new Dictionary<string, Stored>(StringComparer.Ordinal);
        private readonly Dictionary<string, HashSet<string>> _demand = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        private readonly HashSet<string> _fullWidth = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<int, RootRead> _roots = new Dictionary<int, RootRead>();

        public RunFetchStore(RunDiagnostics diagnostics = null)
        {
            _diagnostics = diagnostics;
        }

        /// <summary>Registers a bucket's pruned columns for a child node (null = full width, which
        /// makes every request for that fetch definition full width).</summary>
        public void DemandColumns(IOrganizationService service, TableConfig node, HashSet<string> columns)
        {
            var key = DefinitionKey(service, FetchKind.Child, node);
            if (columns == null) { _fullWidth.Add(key); return; }
            if (!_demand.TryGetValue(key, out var set))
                _demand[key] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            set.UnionWith(columns);
        }

        /// <summary>The columns a child fetch should request: the run's combined demand for the
        /// definition plus the requester's own (null = full width). Without registered demand,
        /// the requester's own.</summary>
        public HashSet<string> ColumnsFor(IOrganizationService service, TableConfig node, HashSet<string> own)
        {
            var key = DefinitionKey(service, FetchKind.Child, node);
            if (own == null || _fullWidth.Contains(key)) return null;
            if (!_demand.TryGetValue(key, out var set)) return own;
            var combined = new HashSet<string>(set, StringComparer.OrdinalIgnoreCase);
            combined.UnionWith(own);
            return combined;
        }

        /// <summary>The stored rows for this fetch, or the result of <paramref name="fetch"/>
        /// (called with the columns to request), stored. The returned list is shared: copy it
        /// before changing it. A fetch that throws stores nothing.</summary>
        public List<Entity> GetOrFetch(
            IOrganizationService service,
            FetchKind kind,
            TableConfig node,
            IEnumerable<Guid> scope,
            string filterXml,
            HashSet<string> columns,
            Func<HashSet<string>, List<Entity>> fetch)
        {
            var key = DefinitionKey(service, kind, node)
                + "|" + string.Join(",", scope.Distinct().Select(id => id.ToString()).OrderBy(s => s, StringComparer.Ordinal))
                + "|" + (filterXml ?? "");

            if (_fetches.TryGetValue(key, out var stored))
            {
                if (Covers(stored.Columns, columns))
                {
                    if (_diagnostics != null) _diagnostics.FetchesShared++;
                    return stored.Rows;
                }
                var widened = Union(stored.Columns, columns);
                var rows = fetch(widened);
                _fetches[key] = new Stored { Rows = rows, Columns = widened };
                if (_diagnostics != null) _diagnostics.FetchesWidened++;
                return rows;
            }

            var fetched = fetch(columns);
            _fetches[key] = new Stored
            {
                Rows = fetched,
                Columns = columns == null ? null : new HashSet<string>(columns, StringComparer.OrdinalIgnoreCase)
            };
            return fetched;
        }

        /// <summary>Registers a bucket's root columns (Retrieve modes only). Every demand must come
        /// before the service's root is read: the root is never re-read, so a later demand could
        /// not be served and is refused.</summary>
        public void DemandRootColumns(IOrganizationService service, ISet<string> columns, bool allColumns)
        {
            var read = Root(service);
            if (read.Rows != null)
                throw new InvalidOperationException(
                    "Root columns were demanded after the root was read for this service; register every bucket's demand first.");
            if (columns != null) read.Columns.UnionWith(columns);
            read.AllColumns |= allColumns;
        }

        /// <summary>The persisted root records, read once per service with the combined columns.
        /// Shared: build each bucket's roots with RootEntityBuilder.Assemble, which copies.</summary>
        public Dictionary<Guid, Entity> RootsFor(IOrganizationService service, string logicalName, IList<RootInput> inputs)
        {
            var read = Root(service);
            if (read.Rows != null)
            {
                if (_diagnostics != null) _diagnostics.FetchesShared++;
                return read.Rows;
            }
            read.Rows = RootEntityBuilder.Retrieve(service, logicalName, inputs, read.Columns, read.AllColumns);
            return read.Rows;
        }

        private RootRead Root(IOrganizationService service)
        {
            var index = ServiceIndex(service);
            if (!_roots.TryGetValue(index, out var read)) _roots[index] = read = new RootRead();
            return read;
        }

        private static bool Covers(HashSet<string> stored, HashSet<string> requested) =>
            stored == null || (requested != null && stored.IsSupersetOf(requested));

        private static HashSet<string> Union(HashSet<string> a, HashSet<string> b)
        {
            if (a == null || b == null) return null;
            var union = new HashSet<string>(a, StringComparer.OrdinalIgnoreCase);
            union.UnionWith(b);
            return union;
        }

        private string DefinitionKey(IOrganizationService service, FetchKind kind, TableConfig node)
        {
            var link = kind == FetchKind.Child ? node.ChildLinkField : node.LookupTargetIdAttribute;
            return ServiceIndex(service) + "|" + kind + "|"
                + (node.TableLogicalName ?? "").ToLowerInvariant() + "|" + (link ?? "").ToLowerInvariant();
        }

        // Reference identity: a run has at most two traversal services (User, System).
        private int ServiceIndex(IOrganizationService service)
        {
            for (var i = 0; i < _services.Count; i++)
                if (ReferenceEquals(_services[i], service)) return i;
            _services.Add(service);
            return _services.Count - 1;
        }
    }
}
