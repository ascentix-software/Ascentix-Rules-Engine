using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class StructuralChecksTests
    {
        // The rule's root table-config node. Every condition binds to a node in the tree - a
        // condition with no binding is what ConditionEvaluator refuses to run - so the minimal
        // VALID model carries a one-node tree and binds its condition to the root.
        private static readonly Guid RootNodeId = Guid.NewGuid();

        // Minimal valid rule: 1 group with 1 FieldComparison condition + 1 Block action.
        private static RuleForValidation ValidModel(Action<RuleForValidation> mutate = null)
        {
            var grp = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                LogicalOperator = LogicalOperator.And,
                Conditions = new List<RuleCondition>
                {
                    new RuleCondition
                    {
                        Id = Guid.NewGuid(),
                        TableConfigNodeId = RootNodeId,
                        ConditionType = ConditionType.FieldComparison,
                        ComparisonColumn = "name",
                        ComparisonOperator = ComparisonOperator.Equals,
                        ValueSource = ComparisonValueSource.Literal,
                        ComparisonValue = "x",
                    }
                },
                ChildGroups = new List<ConditionGroup>(),
            };
            var model = new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "account",
                Groups = new List<ConditionGroup> { grp },
                Configs = TestTree.RawTree(TestTree.Node(RootNodeId, "account", TableConfigType.RootTable, null)),
                Actions = new List<RuleAction>
                {
                    new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.Block, FireOn = ActionFireOn.OnNoMatch, Message = "no", IsActive = true }
                },
            };
            mutate?.Invoke(model);
            return model;
        }

        private static List<ValidationIssue> Run(RuleForValidation m) => new StructuralChecks().Check(m).ToList();

        [Fact]
        public void Valid_minimal_rule_has_no_structural_issues()
            => Assert.Empty(Run(ValidModel()));

        [Fact]
        public void No_conditions_flagged()
        {
            var m = ValidModel(x => ((List<ConditionGroup>)x.Groups)[0].Conditions = new List<RuleCondition>());
            Assert.Contains(Run(m), i => i.Code == "STRUCT_NO_CONDITIONS");
            Assert.Contains(Run(m), i => i.Code == "STRUCT_EMPTY_GROUP");
        }

        [Fact]
        public void No_actions_flagged()
        {
            var m = ValidModel(x => x.Actions = new List<RuleAction>());
            Assert.Contains(Run(m), i => i.Code == "STRUCT_NO_ACTIONS");
        }

        [Fact]
        public void FieldComparison_missing_column_flagged()
        {
            var m = ValidModel(x => ((List<ConditionGroup>)x.Groups)[0].Conditions[0].ComparisonColumn = null);
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Kind == TargetKind.Condition);
        }

        [Fact]
        public void FieldComparison_isnull_operator_needs_no_value()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ComparisonOperator = ComparisonOperator.IsNull;
                c.ComparisonValue = null;
            });
            Assert.DoesNotContain(Run(m), i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void Template_source_condition_without_a_value_is_flagged()
        {
            // Today only Literal is checked, so a Template condition with a blank value
            // validates clean and then NREs at runtime (TemplateRenderer.Tokenize on null).
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ValueSource = ComparisonValueSource.Template;
                c.ComparisonValue = null;
            });
            var issues = Run(m);
            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "ComparisonValue");
        }

        [Fact]
        public void DateExpression_source_condition_without_a_value_is_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ValueSource = ComparisonValueSource.DateExpression;
                c.ComparisonValue = null;
            });
            var issues = Run(m);
            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "ComparisonValue");
        }

        [Fact]
        public void FieldReference_requires_node_and_column()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ValueSource = ComparisonValueSource.FieldReference;
                c.ComparisonValue = null;
                c.ComparisonValueColumn = null; // missing
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void RowCount_requires_a_bound()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.RowCount;
                c.MinExpectedRows = null;
                c.MaxExpectedRows = null;
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void RowCount_min_greater_than_max_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.RowCount;
                c.MinExpectedRows = 5;
                c.MaxExpectedRows = 2;
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_ROWCOUNT_RANGE");
        }

        [Theory]
        [InlineData(-1, null)]
        [InlineData(null, -1)]
        public void RowCount_with_a_negative_bound_is_flagged(int? min, int? max)
        {
            // Historical context: before this check existed, a negative MinExpectedRows validated
            // clean and then passed vacuously at runtime (filtered.Count >= -1 is always true),
            // the same silent-pass failure mode the EXISTS equivalent already guarded against.
            // This check now flags negative bounds here too, pinning that runtime behavior shut.
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.RowCount;
                c.MinExpectedRows = min;
                c.MaxExpectedRows = max;
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_ROWCOUNT_NEGATIVE");
        }

        [Fact]
        public void RegexMatch_invalid_pattern_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.RegexMatch;
                c.ComparisonColumn = "name";
                c.ComparisonValue = "([unclosed";
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_INVALID_REGEX");
        }

        [Fact]
        public void Expression_missing_expression_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.Expression;
                c.Expression = null;
                c.ComparisonOperator = ComparisonOperator.Equals;
                c.ComparisonValue = "1";
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "Expression");
        }

        [Fact]
        public void Expression_unparseable_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.Expression;
                c.Expression = "1 +";
                c.ComparisonOperator = ComparisonOperator.Equals;
                c.ComparisonValue = "1";
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_INVALID_EXPRESSION");
        }

        [Fact]
        public void Expression_missing_operator_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.Expression;
                c.Expression = "1 + 1";
                c.ComparisonOperator = null;
                c.ComparisonValue = "1";
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "ComparisonOperator");
        }

        [Fact]
        public void Expression_valid_expression_not_flagged()
        {
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.Expression;
                c.Expression = "{root.creditlimit} + 1";
                c.ComparisonOperator = ComparisonOperator.GreaterThan;
                c.ComparisonValue = "1";
            });
            var issues = Run(m);
            Assert.DoesNotContain(issues, i => i.Code == "STRUCT_INVALID_EXPRESSION");
            Assert.DoesNotContain(issues, i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void Expression_condition_using_a_filter_key_is_flagged()
        {
            // StructuralChecks calls MathExpr.Parse, which accepts filter: - so a rule that can
            // never run (ConditionEvaluator has no filters map for condition Expressions) passed
            // validation before this check existed.
            var m = ValidModel(x =>
            {
                var c = ((List<ConditionGroup>)x.Groups)[0].Conditions[0];
                c.ConditionType = ConditionType.Expression;
                c.Expression = "sum(node:11111111-1111-1111-1111-111111111111.amount filter:f1)";
                c.ComparisonOperator = ComparisonOperator.GreaterThan;
                c.ComparisonValue = "1";
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_EXPR_FILTER_UNSUPPORTED");
        }

        [Fact]
        public void Null_actiontype_flagged()
        {
            var m = ValidModel(x => x.Actions = new List<RuleAction>
            {
                new RuleAction { Id = Guid.NewGuid(), ActionType = (ActionType)0, FireOn = ActionFireOn.OnNoMatch, IsActive = true }
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_BAD_ACTIONTYPE");
        }

        [Fact]
        public void CreateRecord_requires_target_table_and_mappings()
        {
            var m = ValidModel(x => x.Actions = new List<RuleAction>
            {
                new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = null, FieldMapping = null, Order = 1 }
            });
            var issues = Run(m);
            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "TargetTable");
            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "FieldMapping");
        }

        [Fact]
        public void ShowMessage_requires_message()
        {
            var m = ValidModel(x => x.Actions = new List<RuleAction>
            {
                new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.ShowMessage, FireOn = ActionFireOn.OnMatch, IsActive = true, Message = null }
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "Message");
        }

        [Fact]
        public void UpdateRecord_requires_target_node_and_mapping()
        {
            var m = ValidModel(x => x.Actions = new List<RuleAction>
            {
                new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = null, FieldMapping = null, Order = 1 }
            });
            var issues = Run(m);
            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "TargetNodeId");
            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "FieldMapping");
        }

        [Fact]
        public void Condition_without_a_table_config_node_binding_is_flagged()
        {
            // The UI-authored shape: asx_tableconfig saved null, so TableConfigNodeId is
            // Guid.Empty. Left unflagged, the rule validates and publishes and then every write
            // to the table throws out of ConditionEvaluator.
            var m = ValidModel(x => ((List<ConditionGroup>)x.Groups)[0].Conditions[0].TableConfigNodeId = Guid.Empty);
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD"
                                         && i.Target.Kind == TargetKind.Condition
                                         && i.Target.Field == "TableConfigNodeId");
        }

        [Fact]
        public void Condition_bound_to_a_node_outside_the_config_tree_is_flagged()
        {
            var foreign = Guid.NewGuid();
            var m = ValidModel(x => ((List<ConditionGroup>)x.Groups)[0].Conditions[0].TableConfigNodeId = foreign);
            Assert.Contains(Run(m), i => i.Code == "STRUCT_NODE_NOT_IN_TREE"
                                         && i.Target.Kind == TargetKind.Condition
                                         && i.Target.Field == "TableConfigNodeId");
        }

        [Fact]
        public void DeleteRecord_requires_target_node()
        {
            var m = ValidModel(x => x.Actions = new List<RuleAction>
            {
                new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.DeleteRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = null, Order = 1 }
            });
            Assert.Contains(Run(m), i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Field == "TargetNodeId");
        }
    }
}
