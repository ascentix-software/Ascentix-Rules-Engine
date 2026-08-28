using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;
using LogicalOperator = Ascentix.RulesEngine.Core.Models.LogicalOperator;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>TRAV_PUSHDOWN advisory + the engine-settings kill switch read.</summary>
    public class PushdownChecksTests
    {
        private static readonly Guid NodeId = Guid.NewGuid();

        private static RuleForValidation Model(NodeFilterGroup filter, RuleCondition cond)
        {
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = new List<RuleCondition> { cond },
                NodeFilterGroups = filter == null ? new List<NodeFilterGroup>() : new List<NodeFilterGroup> { filter },
            };
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "sample_order",
                Groups = new List<ConditionGroup> { group },
                Configs = TestTree.RawTree(
                    new TableConfig { Id = NodeId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid" }),
                Actions = new List<RuleAction>(),
            };
        }

        private static RuleCondition RowCount() => new RuleCondition
        { Id = Guid.NewGuid(), TableConfigNodeId = NodeId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };

        [Fact]
        public void Residual_criteria_produce_the_warning()
        {
            var cond = RowCount();
            var filter = new NodeFilterGroup
            {
                TableConfigNodeId = NodeId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { FieldName = "sample_name", Operator = "contains", Value = "x" } },
            };
            var issues = PushdownChecks.Check(Model(filter, cond));
            var w = Assert.Single(issues);
            Assert.Equal(PushdownChecks.CodePushdownResidual, w.Code);
            Assert.Equal(IssueSeverity.Warning, w.Severity);
            Assert.Contains("sample_orderline", w.Message);
            Assert.Equal(cond.Id, w.Target.Id);
        }

        [Fact]
        public void Fully_pushable_criteria_produce_no_warning()
        {
            var cond = RowCount();
            cond.SearchCriteriaGroups.Add(new SearchCriteriaGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = { new SearchCriterion { FieldName = "statecode", Operator = "eq", Value = "0" } },
            });
            Assert.Empty(PushdownChecks.Check(Model(null, cond)));
        }

        [Fact]
        public void Unfiltered_conditions_are_silent()
        {
            Assert.Empty(PushdownChecks.Check(Model(null, RowCount())));
        }
    }
}
