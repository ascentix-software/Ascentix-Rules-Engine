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
        /// <param name="saved">When non-null, receives one entry per input, in input order: a copy of
        /// the record as retrieved before the overlay (the saved values), an empty entity when
        /// nothing was retrieved, or null in UseTarget mode.</param>
        public static List<Entity> Build(
            IOrganizationService service,
            string logicalName,
            IList<RootInput> inputs,
            ISet<string> columns,
            RootBuildMode mode,
            bool allColumns = false,
            List<Entity> saved = null)
        {
            var retrieved = mode == RootBuildMode.UseTarget
                ? null
                : Retrieve(service, logicalName, inputs, columns, allColumns);
            return Assemble(logicalName, inputs, retrieved, mode, saved);
        }

        /// <summary>The persisted root records of <paramref name="inputs"/> (ids only; one
        /// RetrieveMultiple). Raw: no overlay. Shared by every bucket of a run (RunFetchStore),
        /// so nothing may edit them; <see cref="Assemble"/> copies.</summary>
        public static Dictionary<Guid, Entity> Retrieve(
            IOrganizationService service,
            string logicalName,
            IList<RootInput> inputs,
            ISet<string> columns,
            bool allColumns)
        {
            var ids = inputs.Select(i => i.Id).Where(id => id != Guid.Empty).Distinct().ToList();
            return BatchRetrieve(service, logicalName, ids, columns, allColumns);
        }

        /// <param name="retrieved">From <see cref="Retrieve"/>; never edited. Ignored in UseTarget
        /// mode, where the roots are the Targets themselves.</param>
        public static List<Entity> Assemble(
            string logicalName,
            IList<RootInput> inputs,
            Dictionary<Guid, Entity> retrieved,
            RootBuildMode mode,
            List<Entity> saved = null)
        {
            if (mode == RootBuildMode.UseTarget)
            {
                if (saved != null) foreach (var _ in inputs) saved.Add(null);
                return inputs.Select(i => i.Overlay).ToList();
            }

            // One copy per id: inputs repeating an id share it, as they shared the retrieved
            // entity before the read was shared between buckets.
            var copies = new Dictionary<Guid, Entity>();
            var result = new List<Entity>();
            foreach (var input in inputs)
            {
                if (!copies.TryGetValue(input.Id, out var root))
                {
                    root = retrieved != null && retrieved.TryGetValue(input.Id, out var persisted)
                        ? CopyWithFormatting(persisted)
                        : new Entity(logicalName, input.Id);
                    copies[input.Id] = root;
                }

                if (saved != null) saved.Add(Copy(root));

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

        private static Entity CopyWithFormatting(Entity source)
        {
            var copy = Copy(source);
            if (source.FormattedValues != null)
                foreach (var formatted in source.FormattedValues)
                    copy.FormattedValues[formatted.Key] = formatted.Value;
            return copy;
        }

        private static Entity Copy(Entity source)
        {
            var copy = new Entity(source.LogicalName, source.Id);
            foreach (var attr in source.Attributes) copy[attr.Key] = attr.Value;
            return copy;
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
