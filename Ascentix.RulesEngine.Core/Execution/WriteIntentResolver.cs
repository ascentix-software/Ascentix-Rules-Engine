using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Resolves a fired write-action into concrete <see cref="WriteIntent"/>s (read-only).
    /// <see cref="Resolve"/>: a single-record action. Create targets asx_targettable; Update/Delete/
    /// Deactivate resolve asx_targetnode to a single-cardinality record (null when it resolves to
    /// none). <see cref="ResolveSet"/>: a set action (<see cref="SetActions.IsSetAction"/>), one
    /// intent per row of the target collection that passes the action's Rows filter. Field-mapping
    /// values come from literals, the root record, a related node, the current row (set actions),
    /// a template, an arithmetic calculation, a date expression, or a record reference.
    /// </summary>
    public class WriteIntentResolver
    {
        private readonly TableConfigTree _tree;
        private readonly IAttributeMetadataProvider _metadata;
        private readonly TemplateRenderer _templates;
        private readonly DateTime _utcNow;

        public WriteIntentResolver(TableConfigTree tree, IAttributeMetadataProvider metadata, IOptionLabelProvider labels, DateTime utcNow)
        {
            _tree = tree ?? TableConfigTree.Empty;
            _metadata = metadata;
            _templates = new TemplateRenderer(_tree, labels);
            _utcNow = utcNow;
        }

        public WriteIntent Resolve(RuleAction action, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache, RuleEvaluationContext context)
        {
            WriteIntent intent;
            switch (action.ActionType)
            {
                case ActionType.CreateRecord: intent = ResolveCreate(action, mapping, root, cache, context); break;
                case ActionType.UpdateRecord: intent = ResolveUpdate(action, mapping, root, cache, context); break;
                case ActionType.DeleteRecord: intent = ResolveDelete(action, cache, context); break;
                case ActionType.DeactivateRecord: intent = ResolveDeactivate(action, mapping, root, cache, context); break;
                default:
                    throw new InvalidPluginExecutionException($"WriteIntentResolver received non-write action type {action.ActionType}.");
            }
            // A single-record Update/Deactivate is always sent, as it was before the change set.
            return intent == null ? null : Stamp(intent, action, alwaysWrite: intent.Operation == WriteOperation.Update);
        }

        /// <summary>One intent per filtered row of the set action's target collection, in cache
        /// order; none when no row passes. Update/Deactivate intents carry the rows' loaded values.
        /// A row that IS the evaluated record (the in-flight row, including a Create message whose
        /// id may still be Guid.Empty) is marked <see cref="WriteIntent.RootTargeted"/> so the
        /// change set applies its Update/Deactivate in place instead of sending a request against
        /// that not-yet-real id. Another in-flight row with no id (a sibling in the same
        /// CreateMultiple) gets no Update/Deactivate/Delete: there is no id to send it to, and its
        /// own evaluation writes it in place.</summary>
        public List<WriteIntent> ResolveSet(RuleAction action, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache,
            RuleEvaluationContext context, DateSemantics dates = null)
        {
            if (!SetActions.IsSetAction(action, _tree))
                throw new InvalidPluginExecutionException(
                    $"{action.ActionType} action {action.Id} does not target a collection node; it writes a single record.");
            var node = _tree.Node(action.TargetNodeId.Value);
            var intents = new List<WriteIntent>();
            foreach (var row in FilterRows(action, node, cache, dates))
            {
                if (action.ActionType != ActionType.CreateRecord && row.Id == Guid.Empty && !IsEvaluatedRow(row, root)) continue;
                WriteIntent intent;
                switch (action.ActionType)
                {
                    case ActionType.CreateRecord:
                        if (string.IsNullOrWhiteSpace(action.TargetTable))
                            throw new InvalidPluginExecutionException($"CreateRecord action {action.Id} requires a target table (asx_targettable).");
                        intent = new WriteIntent
                        {
                            Operation = WriteOperation.Create, TargetTable = action.TargetTable, TargetId = Guid.NewGuid(), Context = context,
                            Values = ResolveValues(action, action.TargetTable, mapping, root, cache, row),
                        };
                        break;
                    case ActionType.UpdateRecord:
                        intent = SetUpdate(node, row, root, context, ResolveValues(action, node.TableLogicalName, mapping, root, cache, row));
                        break;
                    case ActionType.DeactivateRecord:
                        intent = SetUpdate(node, row, root, context, DeactivateValues(action, node.TableLogicalName, mapping, root, cache, row));
                        break;
                    default: // DeleteRecord: follows the existing single-root Delete behaviour (no RootTargeted here).
                        intent = new WriteIntent { Operation = WriteOperation.Delete, TargetTable = node.TableLogicalName, TargetId = row.Id, Context = context };
                        break;
                }
                intents.Add(Stamp(intent, action, alwaysWrite: false));
            }
            return intents;
        }

        private List<Entity> FilterRows(RuleAction action, TableConfig node, QueryResultCache cache, DateSemantics dates)
        {
            var rows = cache.Get(node.Id);
            if (action.RowFilter == null) return rows.ToList();
            var fieldValues = new FieldValueResolver();
            var comparands = new ComparisonValueResolver(cache, _tree, fieldValues, _metadata as IOptionLabelProvider, _utcNow);
            var filter = new NodeFilterEvaluator(fieldValues, comparands, cache, _tree) { Dates = dates };
            return rows.Where(r => filter.EvaluateFilterGroup(action.RowFilter, new List<Entity> { r }, node.Id)).ToList();
        }

        private static WriteIntent SetUpdate(TableConfig node, Entity row, Entity root, RuleEvaluationContext context, Dictionary<string, object> values) =>
            new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = node.TableLogicalName, TargetId = row.Id, Context = context,
                RootTargeted = IsEvaluatedRow(row, root),
                Values = values, LoadedValues = LoadedValuesOf(row, root, values.Keys),
            };

        // The row IS the evaluated record: the in-flight reconciler's copy of the record being
        // saved (added into every collection it belongs to). With no id yet (a Create message
        // whose Target carries none) every in-flight row of a CreateMultiple is Guid.Empty, so the
        // row must be the reconciler's copy of THIS root, not merely share its empty id.
        private static bool IsEvaluatedRow(Entity row, Entity root) =>
            root != null && string.Equals(row.LogicalName, root.LogicalName, StringComparison.OrdinalIgnoreCase)
            && (row.Id != Guid.Empty ? row.Id == root.Id : InFlightReconciler.IsRowOf(row, root));

        // A set target is a hard reader, fetched with every column: a column absent from its row is
        // null. The row that IS the evaluated record may be the in-flight reconciler's copy of a
        // column-scoped root read, so its values are unknown (null dictionary ⇒ counts as changed).
        private static Dictionary<string, object> LoadedValuesOf(Entity row, Entity root, IEnumerable<string> columns)
        {
            if (IsEvaluatedRow(row, root)) return null;
            var loaded = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var column in columns) loaded[column] = row.Contains(column) ? row[column] : null;
            return loaded;
        }

        private static WriteIntent Stamp(WriteIntent intent, RuleAction action, bool alwaysWrite)
        {
            intent.SourceActionId = action.Id;
            intent.SourceActionName = action.Name;
            intent.SourceActionOrder = action.Order;
            intent.AlwaysWrite = alwaysWrite;
            return intent;
        }

        private WriteIntent ResolveCreate(RuleAction action, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache, RuleEvaluationContext context)
        {
            if (string.IsNullOrWhiteSpace(action.TargetTable))
                throw new InvalidPluginExecutionException($"CreateRecord action {action.Id} requires a target table (asx_targettable).");
            return new WriteIntent
            {
                Operation = WriteOperation.Create, TargetTable = action.TargetTable, TargetId = Guid.NewGuid(),
                RootTargeted = false, Context = context, Values = ResolveValues(action, action.TargetTable, mapping, root, cache),
            };
        }

        private WriteIntent ResolveUpdate(RuleAction action, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache, RuleEvaluationContext context) =>
            ResolveSingleUpdate(action, node => ResolveValues(action, node.TableLogicalName, mapping, root, cache), cache, context);

        private WriteIntent ResolveDeactivate(RuleAction action, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache, RuleEvaluationContext context) =>
            ResolveSingleUpdate(action, node => DeactivateValues(action, node.TableLogicalName, mapping, root, cache, null), cache, context);

        // Shared by ResolveUpdate and ResolveDeactivate: both resolve the single target record and
        // write an Update intent; only how the values are computed differs.
        private WriteIntent ResolveSingleUpdate(RuleAction action, Func<TableConfig, Dictionary<string, object>> resolveValues,
            QueryResultCache cache, RuleEvaluationContext context)
        {
            var node = RequireNode(action);
            var record = ResolveSingleRecord(action, node, cache);
            if (record == null) return null; // no-op
            return new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = node.TableLogicalName, TargetId = record.Id,
                RootTargeted = node.ConfigType == TableConfigType.RootTable, Context = context,
                Values = resolveValues(node),
            };
        }

        private WriteIntent ResolveDelete(RuleAction action, QueryResultCache cache, RuleEvaluationContext context)
        {
            var node = RequireNode(action);
            var record = ResolveSingleRecord(action, node, cache);
            if (record == null) return null; // no-op
            return new WriteIntent
            {
                Operation = WriteOperation.Delete, TargetTable = node.TableLogicalName, TargetId = record.Id,
                RootTargeted = node.ConfigType == TableConfigType.RootTable, Context = context,
            };
        }

        // statecode = 1; statuscode from the mapping when it maps one, else the table's default
        // status for state 1. Other mapped columns are rejected at publish (STRUCT_DEACTIVATE_MAPPING).
        private Dictionary<string, object> DeactivateValues(RuleAction action, string table, List<FieldMappingEntry> mapping,
            Entity root, QueryResultCache cache, Entity row)
        {
            var mapped = ResolveValues(action, table, mapping, root, cache, row);
            var values = new Dictionary<string, object> { ["statecode"] = new OptionSetValue(1) };
            if (mapped.TryGetValue("statuscode", out var status) && status != null) values["statuscode"] = status;
            else values["statuscode"] = new OptionSetValue(DefaultInactiveStatus(table));
            return values;
        }

        private int DefaultInactiveStatus(string table)
        {
            var status = (_metadata as IStatusMetadataProvider)?.GetDefaultStatus(table, 1);
            if (!status.HasValue)
                throw new InvalidPluginExecutionException($"Deactivate Record on '{table}': the table has no status reason for the inactive state.");
            return status.Value;
        }

        private TableConfig RequireNode(RuleAction action)
        {
            if (!action.TargetNodeId.HasValue)
                throw new InvalidPluginExecutionException(
                    $"{action.ActionType} action {action.Id} requires a target node (asx_targetnode).");
            if (!_tree.TryGetNode(action.TargetNodeId.Value, out var node))
                throw new InvalidPluginExecutionException(
                    $"{action.ActionType} action {action.Id}: target node {action.TargetNodeId} is not in the rule's config tree.");
            EnsureSingleCardinality(action, node);
            return node;
        }

        private Entity ResolveSingleRecord(RuleAction action, TableConfig node, QueryResultCache cache)
        {
            var records = cache.Get(node.Id);
            if (records.Count == 0) return null;
            if (records.Count > 1)
                throw new InvalidPluginExecutionException(
                    $"{action.ActionType} action {action.Id}: target node '{node.TableLogicalName}' resolved " +
                    $"{records.Count} records; a single-record write must resolve to exactly one.");
            return records[0];
        }

        private void EnsureSingleCardinality(RuleAction action, TableConfig node)
        {
            _tree.RequireSingleCardinality(node.Id, $"{action.ActionType} action {action.Id}");
        }

        private Dictionary<string, object> ResolveValues(
            RuleAction action, string targetTable, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache, Entity row = null)
        {
            var values = new Dictionary<string, object>();
            if (mapping == null) return values;

            foreach (var entry in mapping)
            {
                switch (entry.Source)
                {
                    case "literal":
                        values[entry.Target] = LiteralCoercer.Coerce(entry.Value, targetTable, entry.Target, _metadata);
                        break;
                    case "root":
                        values[entry.Target] = ReadRaw(root, entry.Column);
                        break;
                    case "node":
                        values[entry.Target] = ReadNodeValue(action, entry, cache);
                        break;
                    case "ref":
                        EnsureTargetType(targetTable, entry.Target,
                            new[] { AttributeTypeCode.Lookup, AttributeTypeCode.Customer, AttributeTypeCode.Owner },
                            "a record reference");
                        values[entry.Target] = ResolveRefValue(action, entry, root, cache);
                        break;
                    case "row":
                        if (row == null)
                            throw new InvalidPluginExecutionException(
                                $"Field mapping for '{entry.Target}' uses the current row, but action {action.Id} does not write a set of rows.");
                        values[entry.Target] = ResolveRowValue(targetTable, entry, row);
                        break;
                    case "template":
                        EnsureTargetType(targetTable, entry.Target,
                            new[] { AttributeTypeCode.String, AttributeTypeCode.Memo }, "a text template");
                        values[entry.Target] = _templates.Render(entry.Template, root, cache,
                            $"Field mapping for '{entry.Target}'", row);
                        break;
                    case "mathexpr":
                        EnsureTargetType(targetTable, entry.Target,
                            new[] { AttributeTypeCode.Integer, AttributeTypeCode.BigInt,
                                    AttributeTypeCode.Decimal, AttributeTypeCode.Double, AttributeTypeCode.Money },
                            "a calculation");
                        var ctx = $"Field mapping for '{entry.Target}'";
                        var ast = MathExpr.Parse(entry.Expression, ctx);
                        var resolver = new FieldValueResolver();
                        var valueResolver = new ComparisonValueResolver(cache, _tree, resolver,
                            _metadata as IOptionLabelProvider, _utcNow);
                        var filterEval = new NodeFilterEvaluator(resolver, valueResolver, cache, _tree);
                        if (MathExprEvaluator.TryEvaluate(ast, root, cache, _tree, ctx,
                                entry.Filters, filterEval, out var computed))
                            values[entry.Target] = CoerceNumeric(
                                computed, _metadata.GetAttributeType(targetTable, entry.Target).Value, ctx);
                        // else: no value (null operand / div-by-zero) => write nothing
                        break;
                    case "dateexpr":
                        EnsureTargetType(targetTable, entry.Target,
                            new[] { AttributeTypeCode.DateTime }, "a date expression");
                        var spec = new DateExprSpec(entry.AnchorKind, entry.AnchorNode, entry.AnchorColumn,
                            entry.Op, entry.Amount, entry.Unit);
                        if (DateExprEvaluator.TryEvaluateFromRaw(spec, root, cache, _tree, _utcNow,
                                $"Field mapping for '{entry.Target}'", out var when))
                            values[entry.Target] = when;
                        // else: null anchor field => write nothing for this column
                        break;
                    default:
                        throw new InvalidPluginExecutionException(
                            $"Field mapping for '{entry.Target}' has unknown source '{entry.Source}'.");
                }
            }
            return values;
        }

        // A row source onto a Lookup/Customer/Owner column that names the row's own id column
        // (contactid; activityid for activities) writes a reference to the row; anything else is
        // the row's raw value, as the root and node sources copy theirs.
        private object ResolveRowValue(string targetTable, FieldMappingEntry entry, Entity row)
        {
            var type = _metadata.GetAttributeType(targetTable, entry.Target);
            var lookup = type == AttributeTypeCode.Lookup || type == AttributeTypeCode.Customer || type == AttributeTypeCode.Owner;
            if (lookup && IsOwnIdColumn(row, entry.Column)) return new EntityReference(row.LogicalName, row.Id);
            return ReadRaw(row, entry.Column);
        }

        internal static bool IsOwnIdColumn(Entity row, string column) =>
            !string.IsNullOrEmpty(column)
            && ((row.Contains(column) && row[column] is Guid id && id == row.Id)
                || string.Equals(column, row.LogicalName + "id", StringComparison.OrdinalIgnoreCase));

        private object ReadNodeValue(RuleAction action, FieldMappingEntry entry, QueryResultCache cache)
        {
            if (!entry.Node.HasValue || !_tree.TryGetNode(entry.Node.Value, out var node))
                throw new InvalidPluginExecutionException(
                    $"Field mapping for '{entry.Target}': node {entry.Node} is not in the rule's config tree.");
            EnsureSingleCardinality(action, node);
            var records = cache.Get(node.Id);
            return records.Count == 0 ? null : ReadRaw(records[0], entry.Column);
        }

        private object ResolveRefValue(RuleAction action, FieldMappingEntry entry, Entity root, QueryResultCache cache)
        {
            if (!entry.Node.HasValue || !_tree.TryGetNode(entry.Node.Value, out var node))
                throw new InvalidPluginExecutionException(
                    $"Field mapping for '{entry.Target}': node {entry.Node} is not in the rule's config tree.");
            if (node.ConfigType == TableConfigType.RootTable)
                return new EntityReference(root.LogicalName, root.Id);
            EnsureSingleCardinality(action, node);
            var records = cache.Get(node.Id);
            return records.Count == 0 ? null : new EntityReference(node.TableLogicalName, records[0].Id);
        }

        private static object ReadRaw(Entity record, string column) =>
            record != null && !string.IsNullOrEmpty(column) && record.Contains(column) ? record[column] : null;

        private static object CoerceNumeric(decimal value, AttributeTypeCode type, string ctx)
        {
            try
            {
                switch (type)
                {
                    case AttributeTypeCode.Money: return new Money(value);
                    case AttributeTypeCode.Decimal: return value;
                    case AttributeTypeCode.Double: return (double)value;
                    case AttributeTypeCode.Integer:
                        return checked((int)Math.Round(value, MidpointRounding.AwayFromZero));
                    case AttributeTypeCode.BigInt:
                        return checked((long)Math.Round(value, MidpointRounding.AwayFromZero));
                    default: return value; // unreachable: EnsureTargetType already gated
                }
            }
            catch (OverflowException)
            {
                throw new InvalidPluginExecutionException(
                    $"{ctx}: calculation result {value} is out of range for the target column.");
            }
        }

        private void EnsureTargetType(string table, string column, AttributeTypeCode[] allowed, string what)
        {
            var type = _metadata.GetAttributeType(table, column);
            if (type == null)
                throw new InvalidPluginExecutionException(
                    $"Field mapping targets column '{column}' which does not exist on table '{table}'.");
            foreach (var a in allowed)
                if (type.Value == a) return;
            throw new InvalidPluginExecutionException(
                $"Field mapping for '{column}' on '{table}' uses {what}, but the column is {type.Value}. " +
                $"Allowed: {string.Join(", ", allowed.Select(a => a.ToString()))}.");
        }
    }
}
