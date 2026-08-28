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
    /// Resolves a fired write-action into a concrete <see cref="WriteIntent"/> (read-only). Create
    /// targets asx_targettable; Update/Delete resolve asx_targetnode to a single-cardinality record
    /// (root or lookup-chain, so a child/1:many node is an author error). Returns null when an
    /// Update/Delete target resolves to no record (no-op). Field-mapping values come from literals
    /// (coerced to the target column type), the root record, a related node (raw attribute value),
    /// a template (rendered with formatting), an arithmetic calculation (`mathexpr`, evaluated in
    /// decimal and coerced to the numeric target), a date expression (interval arithmetic), or a
    /// record reference (the root or a related single record's own identity).
    /// </summary>
    public class WriteIntentResolver
    {
        private readonly TableConfigTree _tree;
        private readonly IAttributeMetadataProvider _metadata;
        private readonly TemplateRenderer _templates;
        private readonly DateTime _utcNow;

        public WriteIntentResolver(
            TableConfigTree tree,
            IAttributeMetadataProvider metadata,
            IOptionLabelProvider labels,
            DateTime utcNow)
        {
            _tree = tree ?? TableConfigTree.Empty;
            _metadata = metadata;
            _templates = new TemplateRenderer(_tree, labels);
            _utcNow = utcNow;
        }

        public WriteIntent Resolve(
            RuleAction action,
            List<FieldMappingEntry> mapping,
            Entity root,
            QueryResultCache cache,
            RuleEvaluationContext context)
        {
            switch (action.ActionType)
            {
                case ActionType.CreateRecord:
                    return ResolveCreate(action, mapping, root, cache, context);
                case ActionType.UpdateRecord:
                    return ResolveUpdate(action, mapping, root, cache, context);
                case ActionType.DeleteRecord:
                    return ResolveDelete(action, root, cache, context);
                default:
                    throw new InvalidPluginExecutionException(
                        $"WriteIntentResolver received non-write action type {action.ActionType}.");
            }
        }

        private WriteIntent ResolveCreate(RuleAction action, List<FieldMappingEntry> mapping,
            Entity root, QueryResultCache cache, RuleEvaluationContext context)
        {
            if (string.IsNullOrWhiteSpace(action.TargetTable))
                throw new InvalidPluginExecutionException(
                    $"CreateRecord action {action.Id} requires a target table (asx_targettable).");

            return new WriteIntent
            {
                Operation = WriteOperation.Create,
                TargetTable = action.TargetTable,
                TargetId = null,
                RootTargeted = false,
                Context = context,
                Values = ResolveValues(action, action.TargetTable, mapping, root, cache)
            };
        }

        private WriteIntent ResolveUpdate(RuleAction action, List<FieldMappingEntry> mapping,
            Entity root, QueryResultCache cache, RuleEvaluationContext context)
        {
            var node = RequireNode(action);
            var record = ResolveSingleRecord(action, node, cache);
            if (record == null) return null; // no-op

            return new WriteIntent
            {
                Operation = WriteOperation.Update,
                TargetTable = node.TableLogicalName,
                TargetId = record.Id,
                RootTargeted = node.ConfigType == TableConfigType.RootTable,
                Context = context,
                Values = ResolveValues(action, node.TableLogicalName, mapping, root, cache)
            };
        }

        private WriteIntent ResolveDelete(RuleAction action, Entity root,
            QueryResultCache cache, RuleEvaluationContext context)
        {
            var node = RequireNode(action);
            var record = ResolveSingleRecord(action, node, cache);
            if (record == null) return null; // no-op

            return new WriteIntent
            {
                Operation = WriteOperation.Delete,
                TargetTable = node.TableLogicalName,
                TargetId = record.Id,
                RootTargeted = node.ConfigType == TableConfigType.RootTable,
                Context = context
            };
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
            RuleAction action, string targetTable, List<FieldMappingEntry> mapping, Entity root, QueryResultCache cache)
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
                    case "template":
                        EnsureTargetType(targetTable, entry.Target,
                            new[] { AttributeTypeCode.String, AttributeTypeCode.Memo }, "a text template");
                        values[entry.Target] = _templates.Render(entry.Template, root, cache,
                            $"Field mapping for '{entry.Target}'");
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
