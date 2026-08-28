using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>How to build the root entity for the current operation.</summary>
    public enum RootBuildMode
    {
        UseTarget,           // Create: Target carries the full new record
        RetrieveAndOverlay,  // Update: persisted record + unsaved Target values (Target wins)
        RetrieveOnly         // Delete: persisted record only
    }

    /// <summary>One root record to build: its id and (for create/update) the Target overlay.</summary>
    public class RootInput
    {
        public Guid Id { get; set; }
        public Entity Overlay { get; set; }
    }

    /// <summary>
    /// Builds complete root records for evaluation. The engine seeds the root from
    /// the record handed to it and never re-queries it, so Update/Delete must supply
    /// the persisted values. Retrieval is column-scoped (see RootColumnCollector) and
    /// batched into a single RetrieveMultiple for bulk. Shared by the plugin and the
    /// Plan 3 Custom API.
    /// </summary>
    public static class RootEntityBuilder
    {
        /// <param name="allColumns">Retrieve the full record width instead of
        /// <paramref name="columns"/>. Set when a traversal node re-reads the root's own table
        /// and the collector refused to prune it, so the row InFlightReconciler may have to add
        /// back to that node's results carries every column the node's consumers read.</param>
        public static List<Entity> Build(
            IOrganizationService service,
            string logicalName,
            IList<RootInput> inputs,
            ISet<string> columns,
            RootBuildMode mode,
            bool allColumns = false)
        {
            if (mode == RootBuildMode.UseTarget)
                return inputs.Select(i => i.Overlay).ToList();

            var ids = inputs.Select(i => i.Id).Where(id => id != Guid.Empty).Distinct().ToList();
            var retrieved = BatchRetrieve(service, logicalName, ids, columns, allColumns);

            var result = new List<Entity>();
            foreach (var input in inputs)
            {
                retrieved.TryGetValue(input.Id, out var root);
                root = root ?? new Entity(logicalName, input.Id);

                if (mode == RootBuildMode.RetrieveAndOverlay && input.Overlay != null)
                    foreach (var attr in input.Overlay.Attributes)
                    {
                        root[attr.Key] = attr.Value;
                        // The retrieved record's FormattedValues describe the *persisted* value;
                        // once an attribute is overlaid with the in-flight Target value, that
                        // formatting is stale. Carry the Target's formatted value if it supplied
                        // one, otherwise drop the stale entry so consumers (TemplateRenderer)
                        // fall back to formatting the overlaid value instead of masking it.
                        if (input.Overlay.FormattedValues != null
                            && input.Overlay.FormattedValues.TryGetValue(attr.Key, out var formatted))
                            root.FormattedValues[attr.Key] = formatted;
                        else if (root.FormattedValues != null)
                            root.FormattedValues.Remove(attr.Key);
                    }

                result.Add(root);
            }
            return result;
        }

        private static Dictionary<Guid, Entity> BatchRetrieve(
            IOrganizationService service, string logicalName, List<Guid> ids, ISet<string> columns,
            bool allColumns)
        {
            var map = new Dictionary<Guid, Entity>();
            if (ids.Count == 0) return map;

            var query = new QueryExpression(logicalName)
            {
                ColumnSet = allColumns
                    ? new ColumnSet(true)
                    : columns != null && columns.Count > 0
                        ? new ColumnSet(columns.ToArray())
                        : new ColumnSet(false)
            };
            // Primary-key attribute follows the {logicalname}id convention used by all
            // data tables this engine targets (activity tables are out of scope).
            query.Criteria.AddCondition(logicalName + "id", ConditionOperator.In, ids.Cast<object>().ToArray());

            foreach (var entity in service.RetrieveMultiple(query).Entities)
                map[entity.Id] = entity;
            return map;
        }
    }
}
