using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>What the triggering operation is about to do to the in-flight records.</summary>
    public enum InFlightOperation
    {
        Create,
        Update,
        Delete
    }

    /// <summary>One record the triggering operation is creating, updating, or deleting.</summary>
    public class InFlightRecord
    {
        public Guid Id { get; set; }

        /// <summary>The unsaved Target attributes (the Update delta / the Create payload).
        /// Null when the caller supplied only an id (Delete, or a reporting run).</summary>
        public Entity Target { get; set; }

        /// <summary>The record as the engine sees it: persisted values with Target overlaid
        /// (see <see cref="RootEntityBuilder"/>). Used when the row must be added to a result.</summary>
        public Entity Root { get; set; }
    }

    /// <summary>The in-flight records of one operation. All share a table and an operation.</summary>
    public class InFlightBatch
    {
        public string LogicalName { get; set; }
        public InFlightOperation Operation { get; set; }
        public List<InFlightRecord> Records { get; set; } = new List<InFlightRecord>();
    }

    /// <summary>
    /// Reconciles traversal results with the operation that is still in flight.
    ///
    /// Engine steps are PRE-operation (stage 20), so every fetch <see cref="QueryExecutor"/>
    /// issues reads the database as it stood BEFORE the triggering Create/Update/Delete. When the
    /// triggering table also appears as a traversed node, in the ordinary "the root is one of the
    /// rows I aggregate over" shape (order line to order to that order's lines), the triggering
    /// record comes back as its stale persisted copy, is missing entirely, or is still present
    /// though about to be deleted, and the aggregate computes over a database state that never
    /// existed. <see cref="RootEntityBuilder"/> already solves this for the ROOT entity; this
    /// solves it for every other node that fetches the same table.
    ///
    /// Per operation, over the rows of a node whose table matches the in-flight table:
    ///  - Update: overlay the unsaved Target onto the matching row; if a pushed filter kept the
    ///    row out server-side (it was judged against stale values), add the record back.
    ///  - Create: add the not-yet-persisted record to each collection it will belong to.
    ///  - Delete: drop the record from COLLECTIONS. Never from a lookup node, where a rule
    ///    legitimately reads the record being deleted ("block the delete when ...").
    ///
    /// Adding a row is always sound: a pushed variant is a superset-returning relaxation and the
    /// full filter re-applies in memory (see PushdownPlanner / ConditionEvaluator / the filtered
    /// aggregate path in MathExprEvaluator), so a row that does not belong is dropped there.
    /// </summary>
    public static class InFlightReconciler
    {
        /// <summary>
        /// Reconciles one node-variant's fetched <paramref name="rows"/> in place.
        /// <paramref name="scopeIds"/> is what bounded the fetch: the parent ids for a
        /// ChildTable node, the resolved target ids for a LookupTable node. An in-flight
        /// record is only ever added to a result its own fetch would have been scoped to.
        /// </summary>
        public static void Apply(
            List<Entity> rows,
            TableConfig node,
            InFlightBatch inFlight,
            ICollection<Guid> scopeIds)
        {
            if (rows == null || node == null || inFlight == null || inFlight.Records == null) return;
            if (!string.Equals(node.TableLogicalName, inFlight.LogicalName, StringComparison.OrdinalIgnoreCase))
                return;

            var isCollection = node.ConfigType == TableConfigType.ChildTable;
            var scope = AsSet(scopeIds);

            // One pass over the fetched rows; the batch then costs O(records), not O(records x rows).
            var byId = new Dictionary<Guid, Entity>();
            foreach (var row in rows)
                if (row.Id != Guid.Empty && !byId.ContainsKey(row.Id)) byId[row.Id] = row;

            foreach (var record in inFlight.Records)
            {
                Entity existing = null;
                if (record.Id != Guid.Empty) byId.TryGetValue(record.Id, out existing);

                if (inFlight.Operation == InFlightOperation.Delete)
                {
                    if (isCollection && existing != null)
                    {
                        rows.Remove(existing);
                        byId.Remove(record.Id);
                    }
                    continue;
                }

                if (existing != null)
                {
                    Overlay(existing, record.Target);
                    continue;
                }

                if (!Belongs(record, node, isCollection, scope)) continue;
                var added = Clone(record.Root);
                rows.Add(added);
                if (added.Id != Guid.Empty) byId[added.Id] = added;
            }
        }

        // Would this node's own fetch have been scoped to the record? For a collection, the
        // record's link back to the parent must land in the parent set the fetch used; for a
        // lookup, some parent's lookup column must already resolve to the record.
        private static bool Belongs(
            InFlightRecord record, TableConfig node, bool isCollection, HashSet<Guid> scope)
        {
            if (record.Root == null || scope.Count == 0) return false;

            if (!isCollection)
                return record.Id != Guid.Empty && scope.Contains(record.Id);

            if (string.IsNullOrWhiteSpace(node.ChildLinkField)) return false;
            object raw;
            if (!record.Root.Attributes.TryGetValue(node.ChildLinkField, out raw)) return false;
            var parent = raw as EntityReference;
            return parent != null && scope.Contains(parent.Id);
        }

        private static void Overlay(Entity row, Entity target)
        {
            if (target == null) return;
            foreach (var attr in target.Attributes)
            {
                row[attr.Key] = attr.Value;
                // Same rule as RootEntityBuilder: the fetched row's FormattedValues describe the
                // PERSISTED value, so once overlaid they are stale. Carry the Target's formatting
                // if it supplied any, otherwise drop the entry so consumers re-format the value.
                string formatted;
                if (target.FormattedValues != null && target.FormattedValues.TryGetValue(attr.Key, out formatted))
                    row.FormattedValues[attr.Key] = formatted;
                else if (row.FormattedValues != null)
                    row.FormattedValues.Remove(attr.Key);
            }
        }

        // Added rows are copies: the root entity is also the root node's cached record and (for
        // a root-in-place UpdateRecord) the very Target the write executor mutates afterwards.
        // Aliasing it into a collection would let a later write reach back into an evaluated set.
        private static Entity Clone(Entity source)
        {
            var copy = new Entity(source.LogicalName) { Id = source.Id };
            foreach (var attr in source.Attributes) copy[attr.Key] = attr.Value;
            if (source.FormattedValues != null)
                foreach (var formatted in source.FormattedValues)
                    copy.FormattedValues[formatted.Key] = formatted.Value;
            return copy;
        }

        private static HashSet<Guid> AsSet(ICollection<Guid> ids)
        {
            if (ids == null) return new HashSet<Guid>();
            return ids as HashSet<Guid> ?? new HashSet<Guid>(ids);
        }
    }
}
