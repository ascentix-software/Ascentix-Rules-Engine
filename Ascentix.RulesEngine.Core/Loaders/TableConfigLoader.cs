using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Loaders
{
    // ─── Config Loader ────────────────────────────────────────────────────────

    /// <summary>
    /// Loads the full TableConfig tree from Dataverse.
    /// Iteratively fetches ancestor nodes until the root is present, then hands the loaded
    /// nodes to <see cref="TableConfigTree.FromLoadedNodes"/>, which validates the shape
    /// (no root / cycle / missing parent) and computes depth once.
    /// </summary>
    public class TableConfigLoader
    {
        private readonly IOrganizationService _service;

        private static readonly string EntityLogicalName = SchemaNames.Qualify(SchemaNames.TableConfig.Entity);
        private static readonly string IdField = SchemaNames.PrimaryId(SchemaNames.DefaultPrefix, SchemaNames.TableConfig.Entity);
        private static readonly string TableLogicalNameField = SchemaNames.Qualify(SchemaNames.TableConfig.TableLogicalName);
        private static readonly string ConfigTypeField = SchemaNames.Qualify(SchemaNames.TableConfig.TableConfigType);
        private static readonly string ParentTableField = SchemaNames.Qualify(SchemaNames.TableConfig.ParentTable);
        private static readonly string LookupColumnField = SchemaNames.Qualify(SchemaNames.TableConfig.LookupColumnLogicalName);
        private static readonly string ChildLinkField = SchemaNames.Qualify(SchemaNames.TableConfig.ChildLinkField);
        private static readonly string LookupTargetIdField = SchemaNames.Qualify(SchemaNames.TableConfig.LookupTargetIdAttribute);

        public TableConfigLoader(IOrganizationService service)
        {
            _service = service;
        }

        public TableConfigTree LoadConfigs(object[] referencedNodeIds)
            => LoadConfigs(referencedNodeIds, null);

        /// <param name="referencedNodeIds">Nodes the rule structurally references; every one of
        /// them must resolve (fail closed, as described below).</param>
        /// <param name="optionalNodeIds">Nodes referenced only from free text (message-template
        /// <c>{node:guid.column}</c> tokens): fetched and planned when they exist, but a stale or
        /// mistyped token is not a reason to refuse the save: rendering degrades that token to
        /// its raw text and traces the reason.</param>
        public TableConfigTree LoadConfigs(object[] referencedNodeIds, IEnumerable<Guid> optionalNodeIds)
        {
            // Shape validation (no root / cycle / missing parent) and depth live in the tree.
            return TableConfigTree.FromLoadedNodes(LoadNodes(referencedNodeIds, optionalNodeIds));
        }

        /// <summary>The raw nodes behind <see cref="LoadConfigs(object[], IEnumerable{Guid})"/>:
        /// the fetch loop plus the seeded-ids check, WITHOUT shape validation. The validation
        /// sweep builds its tree from these via <see cref="TableConfigTree.FromNodesUnvalidated"/>
        /// so a broken shape is reported as an issue rather than thrown.</summary>
        public IReadOnlyCollection<TableConfig> LoadNodes(object[] referencedNodeIds)
            => LoadNodes(referencedNodeIds, null);

        public IReadOnlyCollection<TableConfig> LoadNodes(object[] referencedNodeIds, IEnumerable<Guid> optionalNodeIds)
        {
            var configs = new Dictionary<Guid, TableConfig>();
            var idsToFetch = referencedNodeIds
                .Concat((optionalNodeIds ?? Enumerable.Empty<Guid>()).Cast<object>())
                .ToArray();

            while (idsToFetch.Length > 0)
            {
                var missingIds = idsToFetch
                    .Cast<Guid>()
                    .Where(id => !configs.ContainsKey(id))
                    .Distinct()
                    .Select(id => (object)id)
                    .ToArray();

                if (missingIds.Length == 0) break;

                var loaded = FetchConfigs(missingIds);

                foreach (var config in loaded)
                    configs[config.Id] = config;

                idsToFetch = loaded
                    .Where(c => c.ParentTableId.HasValue &&
                                !configs.ContainsKey(c.ParentTableId.Value))
                    .Select(c => (object)c.ParentTableId.Value)
                    .Distinct()
                    .ToArray();
            }

            // Every seeded node must have resolved. Dropping one silently is the worst available
            // outcome: the node never enters the query plan, QueryExecutor issues no fetch for it,
            // and every consumer then reads an EMPTY collection (an EXISTS counts zero, a RowCount
            // counts zero), so the rule reaches a confident, wrong verdict and blocks a save it
            // should allow, with nothing logged. This is reachable in practice: a config node
            // created seconds earlier may not yet be visible to this query. Fail closed and name
            // the node instead.
            var unresolved = referencedNodeIds
                .Cast<Guid>()
                .Where(id => id != Guid.Empty && !configs.ContainsKey(id))
                .Distinct()
                .ToList();
            if (unresolved.Count > 0)
                throw new InvalidPluginExecutionException(
                    "Table Config tree: node(s) " + string.Join(", ", unresolved.Select(id => id.ToString())) +
                    " are referenced by the rule but did not load. The rule cannot be evaluated " +
                    "against a partial config tree: a missing node reads as an empty collection " +
                    "and would silently change the outcome. If the node was just created, retry; " +
                    "if it was deleted, re-save the rule in the editor to drop the reference.");

            return configs.Values;
        }

        private List<TableConfig> FetchConfigs(object[] ids)
        {
            var query = new QueryExpression(EntityLogicalName)
            {
                ColumnSet = new ColumnSet(
                    TableLogicalNameField,
                    ConfigTypeField,
                    ParentTableField,
                    LookupColumnField,
                    ChildLinkField,
                    LookupTargetIdField)
            };

            query.Criteria.AddCondition(IdField, ConditionOperator.In, ids);

            var results = _service.RetrieveMultiple(query);
            return results.Entities.Select(e => MapToConfig(e)).ToList();
        }

        private TableConfig MapToConfig(Entity e)
        {
            return new TableConfig
            {
                Id = e.Id,
                TableLogicalName = e.GetAttributeValue<string>(TableLogicalNameField),
                ConfigType = (TableConfigType)e.GetAttributeValue<OptionSetValue>(ConfigTypeField).Value,
                ParentTableId = e.GetAttributeValue<EntityReference>(ParentTableField)?.Id,
                LookupColumnLogicalName = e.GetAttributeValue<string>(LookupColumnField),
                ChildLinkField = e.GetAttributeValue<string>(ChildLinkField),
                LookupTargetIdAttribute = e.GetAttributeValue<string>(LookupTargetIdField)
            };
        }
    }
}
