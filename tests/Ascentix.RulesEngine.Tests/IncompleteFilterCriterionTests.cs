using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Regression pin for the blank-criterion defect (see
    /// client/e2e/nodeFilterUi.e2e.spec.ts).
    ///
    /// A node-filter COMPARISON criterion with no column or no operator is not inert:
    /// NodeFilterEvaluator throws "Node filter criterion has no operator configured." /
    /// "... has no column configured.", which reaches the user as a 400 that blocks the write.
    /// StructuralChecks must inspect comparison fields, not only Exists-specific ones, or such
    /// a rule validates clean, publishes, and then fails every save on its table. The editor no
    /// longer writes incomplete criteria; these checks catch rules ALREADY stored that way, and
    /// anything else writing the tables directly.
    /// </summary>
    public class IncompleteFilterCriterionTests
    {
        private static RuleForValidation ModelWithCriterion(NodeFilterCriterion criterion)
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig
                {
                    Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account",
                },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion> { criterion },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                LogicalOperator = LogicalOperator.And,
                Conditions = new List<RuleCondition>
                {
                    new RuleCondition
                    {
                        Id = Guid.NewGuid(),
                        ConditionType = ConditionType.FieldComparison,
                        TableConfigNodeId = rootId,
                        ComparisonColumn = "name",
                        ComparisonOperator = ComparisonOperator.Equals,
                        ValueSource = ComparisonValueSource.Literal,
                        ComparisonValue = "x",
                    },
                },
                ChildGroups = new List<ConditionGroup>(),
                NodeFilterGroups = new List<NodeFilterGroup> { filterGroup },
            };
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "account",
                Groups = new List<ConditionGroup> { group },
                Configs = TestTree.RawTree(configs),
                Actions = new List<RuleAction>
                {
                    new RuleAction
                    {
                        Id = Guid.NewGuid(), ActionType = ActionType.Block,
                        FireOn = ActionFireOn.OnNoMatch, Message = "no", IsActive = true,
                    },
                },
            };
        }

        private static List<ValidationIssue> Run(RuleForValidation m) =>
            new StructuralChecks().Check(m).ToList();

        [Fact]
        public void Wholly_blank_comparison_criterion_is_flagged()
        {
            // Exactly what an auto-seeded, never-filled filter row would persist.
            var issues = Run(ModelWithCriterion(new NodeFilterCriterion()));
            Assert.Equal(2, issues.Count(i => i.Code == "STRUCT_MISSING_FIELD"));
        }

        [Fact]
        public void Comparison_criterion_without_an_operator_is_flagged()
        {
            var issues = Run(ModelWithCriterion(new NodeFilterCriterion { FieldName = "name" }));
            var missing = issues.Where(i => i.Code == "STRUCT_MISSING_FIELD").ToList();
            Assert.Single(missing);
            Assert.Contains("operator", missing[0].Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Comparison_criterion_without_a_column_is_flagged()
        {
            var issues = Run(ModelWithCriterion(new NodeFilterCriterion { Operator = "eq", Value = "x" }));
            var missing = issues.Where(i => i.Code == "STRUCT_MISSING_FIELD").ToList();
            Assert.Single(missing);
            Assert.Contains("column", missing[0].Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Complete_comparison_criterion_is_not_flagged()
        {
            var issues = Run(ModelWithCriterion(
                new NodeFilterCriterion { FieldName = "name", Operator = "eq", Value = "x" }));
            Assert.DoesNotContain(issues, i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void Valueless_operator_needs_no_value()
        {
            // "null"/"not-null" are complete without a Value, so the check must not demand one.
            var issues = Run(ModelWithCriterion(
                new NodeFilterCriterion { FieldName = "name", Operator = "null" }));
            Assert.DoesNotContain(issues, i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void Exists_criterion_is_unaffected_by_the_comparison_checks()
        {
            // An Exists criterion legitimately has no FieldName/Operator; it must not be caught
            // by the new comparison-shaped checks.
            var issues = Run(ModelWithCriterion(new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = Guid.NewGuid(),
                MinCount = 1,
            }));
            Assert.DoesNotContain(issues, i => i.Code == "STRUCT_MISSING_FIELD");
        }
    }
}
