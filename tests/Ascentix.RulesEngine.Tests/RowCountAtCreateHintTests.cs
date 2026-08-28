using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>The STRUCT_ROWCOUNT_ON_CREATE authoring hint: a min-rows RowCount on a
    /// structurally-empty-at-create collection (child-links-only path to root) combined with the
    /// OnCreate trigger can never pass during Create. Warning, never blocking.</summary>
    public class RowCountAtCreateHintTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LineId = Guid.NewGuid();      // child of root
        private static readonly Guid SubLineId = Guid.NewGuid();   // child of child of root
        private static readonly Guid CustomerId = Guid.NewGuid();  // lookup off root
        private static readonly Guid CustOrdersId = Guid.NewGuid();// child under the lookup

        private static RuleForValidation Model(bool onCreate, RuleCondition condition)
            => Model(onCreate, condition, TestTree.Tree(
                new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = LineId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid", ParentTableId = RootId },
                new TableConfig { Id = SubLineId, TableLogicalName = "sample_subline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_lineid", ParentTableId = LineId },
                new TableConfig { Id = CustomerId, TableLogicalName = "sample_customer", ConfigType = TableConfigType.LookupTable, LookupColumnLogicalName = "sample_customerid", LookupTargetIdAttribute = "sample_customerid", ParentTableId = RootId },
                new TableConfig { Id = CustOrdersId, TableLogicalName = "sample_order", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_customerid", ParentTableId = CustomerId }));

        private static RuleForValidation Model(bool onCreate, RuleCondition condition, TableConfigTree tree)
        {
            var rule = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            var triggers = onCreate
                ? new[] { RuleTrigger.OnCreate, RuleTrigger.OnUpdate }
                : new[] { RuleTrigger.OnUpdate };
            rule[SchemaNames.Qualify(SchemaNames.Rule.Triggers)] =
                new OptionSetValueCollection(triggers.Select(t => new OptionSetValue((int)t)).ToList());

            return new RuleForValidation
            {
                RuleId = rule.Id,
                RuleEntity = rule,
                PrimaryTable = "sample_order",
                Groups = new List<ConditionGroup>
                {
                    new ConditionGroup { Id = Guid.NewGuid(), Conditions = new List<RuleCondition> { condition } },
                },
                Configs = tree,
                Actions = new List<RuleAction>
                {
                    new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.Block, FireOn = ActionFireOn.OnNoMatch, IsActive = true, Message = "needs a line" },
                },
            };
        }

        private static RuleCondition RowCount(Guid nodeId, int? min) => new RuleCondition
        { Id = Guid.NewGuid(), TableConfigNodeId = nodeId, ConditionType = ConditionType.RowCount, MinExpectedRows = min };

        private static IEnumerable<ValidationIssue> Hints(RuleForValidation m) =>
            new StructuralChecks().Check(m).Where(i => i.Code == "STRUCT_ROWCOUNT_ON_CREATE");

        [Fact]
        public void Min_rows_on_root_child_with_OnCreate_warns()
        {
            var issues = Hints(Model(onCreate: true, RowCount(LineId, 1))).ToList();
            var w = Assert.Single(issues);
            Assert.Equal(IssueSeverity.Warning, w.Severity); // hint, never blocking
            Assert.Contains("can never pass during Create", w.Message);
        }

        [Fact]
        public void Grandchild_collection_also_warns()
        {
            Assert.Single(Hints(Model(onCreate: true, RowCount(SubLineId, 2))));
        }

        [Fact]
        public void No_OnCreate_trigger_no_warning()
        {
            Assert.Empty(Hints(Model(onCreate: false, RowCount(LineId, 1))));
        }

        [Fact]
        public void Max_only_rowcount_does_not_warn()
        {
            // max-N is satisfiable at create (0 <= max). Only min>0 is unsatisfiable.
            Assert.Empty(Hints(Model(onCreate: true, RowCount(LineId, null))));
        }

        [Fact]
        public void Collection_under_a_lookup_is_exempt()
        {
            // The looked-up customer's orders already exist at root-create.
            Assert.Empty(Hints(Model(onCreate: true, RowCount(CustOrdersId, 1))));
        }

        [Fact]
        public void A_51_deep_all_child_chain_still_warns()
        {
            // A hop-capped walker would answer "not empty at create" past the cap, so a
            // min-rows Row Count on a very deep all-child collection would silently lose this
            // hint. The tree's walk is cycle-safe, so there is no cap.
            var nodes = new List<TableConfig>
            {
                new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
            };
            var parent = RootId;
            for (var i = 1; i <= 51; i++)
            {
                var id = Guid.NewGuid();
                nodes.Add(new TableConfig { Id = id, TableLogicalName = "sample_level" + i, ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_parentid", ParentTableId = parent });
                parent = id;
            }
            var deepest = parent;
            var tree = TestTree.Tree(nodes.ToArray());
            Assert.Equal(51, tree.Depth(deepest));

            var issues = Hints(Model(onCreate: true, RowCount(deepest, 1), tree)).ToList();
            Assert.Single(issues);
        }

        [Fact]
        public void Warning_does_not_invalidate_the_rule()
        {
            var report = ValidationReport.From(new StructuralChecks().Check(Model(onCreate: true, RowCount(LineId, 1))));
            Assert.True(report.IsValid);
        }
    }
}
