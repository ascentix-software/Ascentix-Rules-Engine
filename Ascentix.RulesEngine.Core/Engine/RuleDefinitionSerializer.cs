using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Serializes loaded rule definitions for a table into the asx_ReadRules Rules JSON envelope:
    /// { tableLogicalName, languageId, rules:[...] }. A faithful rule-graph representation the
    /// Plan 4B client classifies (root-only vs needs-external) and locally evaluates root-only
    /// rules over. Enums are written as string names; messages are pre-localized; node-filter /
    /// search-criteria detail collapses to the hasNodeFilters marker. Sandbox-safe
    /// (DataContractJsonSerializer). Performs no evaluation.
    /// </summary>
    public static class RuleDefinitionSerializer
    {
        [DataContract]
        private class EnvelopeDto
        {
            [DataMember(Name = "tableLogicalName", Order = 1)] public string TableLogicalName { get; set; }
            [DataMember(Name = "languageId", Order = 2)] public int LanguageId { get; set; }
            [DataMember(Name = "rules", Order = 3)] public List<RuleDto> Rules { get; set; }
        }

        [DataContract]
        private class RuleDto
        {
            [DataMember(Name = "ruleId", Order = 1)] public string RuleId { get; set; }
            [DataMember(Name = "name", Order = 2)] public string Name { get; set; }
            [DataMember(Name = "triggers", Order = 3)] public List<string> Triggers { get; set; }
            [DataMember(Name = "conditionGroups", Order = 4)] public List<ConditionGroupDto> ConditionGroups { get; set; }
            [DataMember(Name = "tableConfig", Order = 5)] public List<TableConfigDto> TableConfig { get; set; }
            [DataMember(Name = "actions", Order = 6)] public List<ActionDto> Actions { get; set; }
        }

        [DataContract]
        private class ConditionGroupDto
        {
            [DataMember(Name = "logicalOperator", Order = 1)] public string LogicalOperator { get; set; }
            [DataMember(Name = "isExecutionCondition", Order = 2)] public bool IsExecutionCondition { get; set; }
            [DataMember(Name = "hasNodeFilters", Order = 3)] public bool HasNodeFilters { get; set; }
            [DataMember(Name = "conditions", Order = 4)] public List<ConditionDto> Conditions { get; set; }
            [DataMember(Name = "groups", Order = 5)] public List<ConditionGroupDto> Groups { get; set; }
        }

        [DataContract]
        private class ConditionDto
        {
            [DataMember(Name = "tableConfigId", Order = 1)] public string TableConfigId { get; set; }
            [DataMember(Name = "conditionType", Order = 2)] public string ConditionType { get; set; }
            [DataMember(Name = "comparisonColumn", Order = 3)] public string ComparisonColumn { get; set; }
            [DataMember(Name = "comparisonOperator", Order = 4)] public string ComparisonOperator { get; set; }
            [DataMember(Name = "valueSource", Order = 5)] public string ValueSource { get; set; }
            [DataMember(Name = "comparisonValue", Order = 6)] public string ComparisonValue { get; set; }
            [DataMember(Name = "referencedTableConfigId", Order = 7)] public string ReferencedTableConfigId { get; set; }
            [DataMember(Name = "referencedColumn", Order = 8)] public string ReferencedColumn { get; set; }
            [DataMember(Name = "minExpectedRows", Order = 9)] public int? MinExpectedRows { get; set; }
            [DataMember(Name = "maxExpectedRows", Order = 10)] public int? MaxExpectedRows { get; set; }
        }

        [DataContract]
        private class TableConfigDto
        {
            [DataMember(Name = "tableConfigId", Order = 1)] public string TableConfigId { get; set; }
            [DataMember(Name = "tableLogicalName", Order = 2)] public string TableLogicalName { get; set; }
            [DataMember(Name = "tableConfigType", Order = 3)] public string TableConfigType { get; set; }
            [DataMember(Name = "parentTableConfigId", Order = 4)] public string ParentTableConfigId { get; set; }
            [DataMember(Name = "lookupColumnLogicalName", Order = 5)] public string LookupColumnLogicalName { get; set; }
            [DataMember(Name = "childLinkField", Order = 6)] public string ChildLinkField { get; set; }
        }

        [DataContract]
        private class ActionDto
        {
            [DataMember(Name = "actionType", Order = 1)] public string ActionType { get; set; }
            [DataMember(Name = "fireOn", Order = 2)] public string FireOn { get; set; }
            [DataMember(Name = "targetColumn", Order = 3)] public string TargetColumn { get; set; }
            [DataMember(Name = "value", Order = 4)] public bool? Value { get; set; }
            [DataMember(Name = "applyInverseWhenNotFired", Order = 5)] public bool ApplyInverseWhenNotFired { get; set; }
            [DataMember(Name = "message", Order = 6)] public string Message { get; set; }
            [DataMember(Name = "severity", Order = 7)] public string Severity { get; set; }
            [DataMember(Name = "targetTable", Order = 8, EmitDefaultValue = false)] public string TargetTable { get; set; }
            [DataMember(Name = "targetNode", Order = 9, EmitDefaultValue = false)] public string TargetNode { get; set; }
            [DataMember(Name = "fieldMapping", Order = 10, EmitDefaultValue = false)] public string FieldMapping { get; set; }
            [DataMember(Name = "order", Order = 11)] public int Order { get; set; }
        }

        private static readonly string NameField = SchemaNames.Qualify(SchemaNames.PrimaryName);
        private static readonly string TriggersField = SchemaNames.Qualify(SchemaNames.Rule.Triggers);

        public static string Combine(string table, int language, IEnumerable<string> definitions)
        {
            var serializer = new DataContractJsonSerializer(typeof(EnvelopeDto));
            var envelope = new EnvelopeDto { TableLogicalName = table, LanguageId = language, Rules = new List<RuleDto>() };
            foreach (var json in definitions)
                using (var input = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                    envelope.Rules.AddRange(((EnvelopeDto)serializer.ReadObject(input)).Rules);
            using (var output = new MemoryStream())
            {
                serializer.WriteObject(output, envelope);
                return Encoding.UTF8.GetString(output.ToArray());
            }
        }

        public static string Serialize(
            string tableLogicalName,
            int languageId,
            IList<Entity> rules,
            IList<ConditionGroup> rootGroups,
            TableConfigTree tree,
            IDictionary<Guid, List<RuleAction>> actionsByRule)
        {
            var ruleDtos = new List<RuleDto>();
            foreach (var rule in rules)
            {
                var ruleGroups = rootGroups.Where(g => g.RuleId == rule.Id).ToList();

                // Condition LHS + RHS nodes only: the envelope's tableConfig is the client's
                // root-only classifier input today. Widen to NodesToLoad when client Plan 4B-2 lands.
                var nodeIds = RuleReferences.Compute(ruleGroups, null)
                    .NodeIds(ReferenceKind.ConditionNodes, ReferenceKind.FieldReferenceNodes);

                actionsByRule.TryGetValue(rule.Id, out var actions);

                ruleDtos.Add(new RuleDto
                {
                    RuleId = rule.Id.ToString(),
                    Name = rule.GetAttributeValue<string>(NameField),
                    Triggers = ReadTriggers(rule),
                    ConditionGroups = ruleGroups.Select(MapGroup).ToList(),
                    TableConfig = nodeIds
                        .Where(tree.Contains)
                        .Select(id => MapTableConfig(tree.Node(id)))
                        .ToList(),
                    Actions = (actions ?? new List<RuleAction>()).Select(a => MapAction(a, languageId)).ToList()
                });
            }

            var envelope = new EnvelopeDto
            {
                TableLogicalName = tableLogicalName,
                LanguageId = languageId,
                Rules = ruleDtos
            };

            var serializer = new DataContractJsonSerializer(typeof(EnvelopeDto));
            using (var ms = new MemoryStream())
            {
                serializer.WriteObject(ms, envelope);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        private static ConditionGroupDto MapGroup(ConditionGroup g) => new ConditionGroupDto
        {
            LogicalOperator = g.LogicalOperator.ToString(),
            IsExecutionCondition = g.IsExecutionCondition,
            HasNodeFilters = g.NodeFilterGroups != null && g.NodeFilterGroups.Count > 0,
            Conditions = g.Conditions.Select(MapCondition).ToList(),
            Groups = g.ChildGroups.Select(MapGroup).ToList()
        };

        private static ConditionDto MapCondition(RuleCondition c) => new ConditionDto
        {
            TableConfigId = c.TableConfigNodeId == Guid.Empty ? null : c.TableConfigNodeId.ToString(),
            ConditionType = c.ConditionType.ToString(),
            ComparisonColumn = c.ComparisonColumn,
            ComparisonOperator = c.ComparisonOperator?.ToString(),
            ValueSource = c.ValueSource.ToString(),
            ComparisonValue = c.ComparisonValue,
            ReferencedTableConfigId = c.ComparisonValueNodeId?.ToString(),
            ReferencedColumn = c.ComparisonValueColumn,
            MinExpectedRows = c.MinExpectedRows,
            MaxExpectedRows = c.MaxExpectedRows
        };

        private static TableConfigDto MapTableConfig(TableConfig t) => new TableConfigDto
        {
            TableConfigId = t.Id.ToString(),
            TableLogicalName = t.TableLogicalName,
            TableConfigType = t.ConfigType.ToString(),
            ParentTableConfigId = t.ParentTableId?.ToString(),
            LookupColumnLogicalName = t.LookupColumnLogicalName,
            ChildLinkField = t.ChildLinkField
        };

        private static ActionDto MapAction(RuleAction a, int languageId)
        {
            var hasMessage = a.ActionType == ActionType.Block || a.ActionType == ActionType.ShowMessage;
            var hasValue = a.ActionType == ActionType.SetVisible || a.ActionType == ActionType.SetRequired;
            return new ActionDto
            {
                ActionType = a.ActionType.ToString(),
                FireOn = a.FireOn.ToString(),
                TargetColumn = a.TargetColumn,
                Value = hasValue ? a.ValueBool : (bool?)null,
                ApplyInverseWhenNotFired = a.ApplyInverseWhenNotFired,
                Message = hasMessage ? MessageResolver.Resolve(a, languageId) : null,
                Severity = hasMessage ? a.Severity?.ToString() : null,
                TargetTable = a.TargetTable,
                TargetNode = a.TargetNodeId?.ToString(),
                FieldMapping = a.FieldMapping,
                Order = a.Order
            };
        }

        private static List<string> ReadTriggers(Entity rule)
        {
            var triggers = rule.GetAttributeValue<OptionSetValueCollection>(TriggersField);
            if (triggers == null) return new List<string>();
            return triggers.Select(o => ((RuleTrigger)o.Value).ToString()).ToList();
        }
    }
}
