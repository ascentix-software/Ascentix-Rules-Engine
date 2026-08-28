using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleDefinitionSerializerTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static Entity Rule(Guid id, string name, RuleTrigger[] triggers)
        {
            var e = new Entity(Q(SchemaNames.Rule.Entity), id);
            e[Q(SchemaNames.PrimaryName)] = name;
            e[Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                triggers.Select(t => new OptionSetValue((int)t)).ToList());
            return e;
        }

        private static ConditionGroup Group(Guid ruleId, LogicalOperator op, bool isExecution,
            List<RuleCondition> conditions, List<ConditionGroup> children = null,
            List<NodeFilterGroup> nodeFilters = null)
            => new ConditionGroup
            {
                Id = Guid.NewGuid(),
                RuleId = ruleId,
                LogicalOperator = op,
                IsExecutionCondition = isExecution,
                Conditions = conditions ?? new List<RuleCondition>(),
                ChildGroups = children ?? new List<ConditionGroup>(),
                NodeFilterGroups = nodeFilters ?? new List<NodeFilterGroup>()
            };

        // The serializer reads nodes by id only, so the fixtures here are node sets rather than
        // whole trees (some have no root); they are handed over as an unvalidated forest.
        private static string Serialize(IList<Entity> rules, IList<ConditionGroup> groups,
            IReadOnlyDictionary<Guid, TableConfig> configs, IDictionary<Guid, List<RuleAction>> actions, int lang = 1033)
            => RuleDefinitionSerializer.Serialize("account", lang, rules, groups, TestTree.RawTree(configs), actions);

        [Fact]
        public void Empty_rules_serializes_to_envelope_with_empty_array()
        {
            var json = Serialize(new List<Entity>(), new List<ConditionGroup>(),
                new Dictionary<Guid, TableConfig>(), new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"tableLogicalName\":\"account\"", json);
            Assert.Contains("\"languageId\":1033", json);
            Assert.Contains("\"rules\":[]", json);
        }

        [Fact]
        public void Root_field_comparison_rule_serializes_full_shape()
        {
            var ruleId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var rule = Rule(ruleId, "Approver required", new[] { RuleTrigger.OnForm });

            var configs = new Dictionary<Guid, TableConfig>
            {
                [nodeId] = new TableConfig { Id = nodeId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable }
            };
            var group = Group(ruleId, LogicalOperator.And, false, new List<RuleCondition>
            {
                new RuleCondition
                {
                    TableConfigNodeId = nodeId,
                    ConditionType = ConditionType.FieldComparison,
                    ComparisonColumn = "creditlimit",
                    ComparisonOperator = ComparisonOperator.GreaterThan,
                    ValueSource = ComparisonValueSource.Literal,
                    ComparisonValue = "10000"
                }
            });
            var actions = new Dictionary<Guid, List<RuleAction>>
            {
                [ruleId] = new List<RuleAction>
                {
                    new RuleAction { RuleId = ruleId, ActionType = ActionType.Block, FireOn = ActionFireOn.OnNoMatch,
                                     Message = "Approver required.", Severity = Severity.Error, Order = 1 }
                }
            };

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup> { group }, configs, actions);

            Assert.Contains("\"ruleId\":\"" + ruleId + "\"", json);
            Assert.Contains("\"name\":\"Approver required\"", json);
            Assert.Contains("\"triggers\":[\"OnForm\"]", json);
            Assert.Contains("\"tableConfigType\":\"RootTable\"", json);
            Assert.Contains("\"conditionType\":\"FieldComparison\"", json);
            Assert.Contains("\"comparisonColumn\":\"creditlimit\"", json);
            Assert.Contains("\"comparisonOperator\":\"GreaterThan\"", json);
            Assert.Contains("\"valueSource\":\"Literal\"", json);
            Assert.Contains("\"comparisonValue\":\"10000\"", json);
            Assert.Contains("\"hasNodeFilters\":false", json);
            Assert.Contains("\"actionType\":\"Block\"", json);
            Assert.Contains("\"message\":\"Approver required.\"", json);
            Assert.Contains("\"value\":null", json);
        }

        [Fact]
        public void Nested_child_group_serializes_under_groups()
        {
            var ruleId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var rule = Rule(ruleId, "Nested", new[] { RuleTrigger.OnForm });
            var configs = new Dictionary<Guid, TableConfig>
            {
                [nodeId] = new TableConfig { Id = nodeId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable }
            };
            var child = Group(ruleId, LogicalOperator.Or, false, new List<RuleCondition>
            {
                new RuleCondition { TableConfigNodeId = nodeId, ConditionType = ConditionType.FieldComparison,
                                    ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull,
                                    ValueSource = ComparisonValueSource.Literal }
            });
            var root = Group(ruleId, LogicalOperator.And, false, new List<RuleCondition>(),
                new List<ConditionGroup> { child });

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup> { root }, configs,
                new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"groups\":[", json);
            Assert.Contains("\"logicalOperator\":\"Or\"", json);
        }

        [Fact]
        public void Field_reference_condition_carries_referenced_node_and_column()
        {
            var ruleId = Guid.NewGuid();
            var rootId = Guid.NewGuid();
            var refId = Guid.NewGuid();
            var rule = Rule(ruleId, "FieldRef", new[] { RuleTrigger.OnForm });
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                [refId] = new TableConfig { Id = refId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable }
            };
            var group = Group(ruleId, LogicalOperator.And, false, new List<RuleCondition>
            {
                new RuleCondition
                {
                    TableConfigNodeId = rootId,
                    ConditionType = ConditionType.FieldComparison,
                    ComparisonColumn = "creditlimit",
                    ComparisonOperator = ComparisonOperator.LessThanOrEqual,
                    ValueSource = ComparisonValueSource.FieldReference,
                    ComparisonValueNodeId = refId,
                    ComparisonValueColumn = "creditonhold"
                }
            });

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup> { group }, configs,
                new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"valueSource\":\"FieldReference\"", json);
            Assert.Contains("\"referencedTableConfigId\":\"" + refId + "\"", json);
            Assert.Contains("\"referencedColumn\":\"creditonhold\"", json);
        }

        [Fact]
        public void Same_record_field_reference_has_null_referenced_node()
        {
            var ruleId = Guid.NewGuid();
            var rootId = Guid.NewGuid();
            var rule = Rule(ruleId, "SameRecFieldRef", new[] { RuleTrigger.OnForm });
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable }
            };
            var group = Group(ruleId, LogicalOperator.And, false, new List<RuleCondition>
            {
                new RuleCondition
                {
                    TableConfigNodeId = rootId,
                    ConditionType = ConditionType.FieldComparison,
                    ComparisonColumn = "creditlimit",
                    ComparisonOperator = ComparisonOperator.LessThanOrEqual,
                    ValueSource = ComparisonValueSource.FieldReference,
                    ComparisonValueNodeId = null,
                    ComparisonValueColumn = "creditonhold"
                }
            });

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup> { group }, configs,
                new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"valueSource\":\"FieldReference\"", json);
            Assert.Contains("\"referencedTableConfigId\":null", json);
            Assert.Contains("\"referencedColumn\":\"creditonhold\"", json);
        }

        [Fact]
        public void RowCount_condition_carries_type_and_bounds()
        {
            var ruleId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var rule = Rule(ruleId, "RowCount", new[] { RuleTrigger.OnForm });
            var configs = new Dictionary<Guid, TableConfig>
            {
                [nodeId] = new TableConfig { Id = nodeId, TableLogicalName = "contact", ConfigType = TableConfigType.ChildTable }
            };
            var group = Group(ruleId, LogicalOperator.And, false, new List<RuleCondition>
            {
                new RuleCondition { TableConfigNodeId = nodeId, ConditionType = ConditionType.RowCount,
                                    ValueSource = ComparisonValueSource.Literal,
                                    MinExpectedRows = 1, MaxExpectedRows = 5 }
            });

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup> { group }, configs,
                new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"conditionType\":\"RowCount\"", json);
            Assert.Contains("\"minExpectedRows\":1", json);
            Assert.Contains("\"maxExpectedRows\":5", json);
            Assert.Contains("\"tableConfigType\":\"ChildTable\"", json);
        }

        [Fact]
        public void Group_with_node_filters_sets_marker_true()
        {
            var ruleId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var rule = Rule(ruleId, "Filtered", new[] { RuleTrigger.OnForm });
            var configs = new Dictionary<Guid, TableConfig>
            {
                [nodeId] = new TableConfig { Id = nodeId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable }
            };
            var group = Group(ruleId, LogicalOperator.And, false,
                new List<RuleCondition>
                {
                    new RuleCondition { TableConfigNodeId = nodeId, ConditionType = ConditionType.FieldComparison,
                                        ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull,
                                        ValueSource = ComparisonValueSource.Literal }
                },
                nodeFilters: new List<NodeFilterGroup> { new NodeFilterGroup() });

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup> { group }, configs,
                new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"hasNodeFilters\":true", json);
        }

        [Fact]
        public void SetVisible_action_serializes_value_and_nulls_message_and_severity()
        {
            var ruleId = Guid.NewGuid();
            var rule = Rule(ruleId, "Visible", new[] { RuleTrigger.OnForm });
            var actions = new Dictionary<Guid, List<RuleAction>>
            {
                [ruleId] = new List<RuleAction>
                {
                    new RuleAction { RuleId = ruleId, ActionType = ActionType.SetVisible, FireOn = ActionFireOn.OnMatch,
                                     TargetColumn = "telephone1", ValueBool = true, ApplyInverseWhenNotFired = true, Order = 1 }
                }
            };

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup>(),
                new Dictionary<Guid, TableConfig>(), actions);

            Assert.Contains("\"actionType\":\"SetVisible\"", json);
            Assert.Contains("\"targetColumn\":\"telephone1\"", json);
            Assert.Contains("\"value\":true", json);
            Assert.Contains("\"applyInverseWhenNotFired\":true", json);
            Assert.Contains("\"message\":null", json);
            Assert.Contains("\"severity\":null", json);
        }

        [Fact]
        public void Multiple_rules_each_appear_with_their_triggers()
        {
            var r1 = Rule(Guid.NewGuid(), "One", new[] { RuleTrigger.OnForm, RuleTrigger.OnUpdate });
            var r2 = Rule(Guid.NewGuid(), "Two", new[] { RuleTrigger.OnForm });

            var json = Serialize(new List<Entity> { r1, r2 }, new List<ConditionGroup>(),
                new Dictionary<Guid, TableConfig>(), new Dictionary<Guid, List<RuleAction>>());

            Assert.Contains("\"ruleId\":\"" + r1.Id + "\"", json);
            Assert.Contains("\"ruleId\":\"" + r2.Id + "\"", json);
            Assert.Contains("\"triggers\":[\"OnForm\",\"OnUpdate\"]", json);
        }

        [Fact]
        public void Create_record_action_serializes_target_table_and_mapping()
        {
            var ruleId = Guid.NewGuid();
            var rule = Rule(ruleId, "Make task", new[] { RuleTrigger.OnCreate });
            var actions = new Dictionary<Guid, List<RuleAction>>
            {
                [ruleId] = new List<RuleAction>
                {
                    new RuleAction { RuleId = ruleId, ActionType = ActionType.CreateRecord,
                        FireOn = ActionFireOn.OnMatch, TargetTable = "task",
                        FieldMapping = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hi\"}]", Order = 1 }
                }
            };

            var json = Serialize(new List<Entity> { rule }, new List<ConditionGroup>(),
                new Dictionary<Guid, TableConfig>(), actions);

            Assert.Contains("\"actionType\":\"CreateRecord\"", json);
            Assert.Contains("\"targetTable\":\"task\"", json);
            Assert.Contains("\"fieldMapping\":", json);
        }
    }
}
