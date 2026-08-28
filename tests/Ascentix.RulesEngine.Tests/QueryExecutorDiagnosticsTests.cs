using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class QueryExecutorDiagnosticsTests
    {
        // A child node under root; one RetrieveMultiple is expected, tallied to the node.
        [Fact]
        public void Child_node_records_one_retrieve_multiple_with_row_count()
        {
            var rootCfgId = Guid.NewGuid();
            var childCfgId = Guid.NewGuid();
            var rootId = Guid.NewGuid();

            var configs = TestTree.Tree(
                new TableConfig { Id = rootCfgId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childCfgId, TableLogicalName = "contact", ConfigType = TableConfigType.ChildTable, ParentTableId = rootCfgId, ChildLinkField = "parentcustomerid" });

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity("contact", Guid.NewGuid()) { ["parentcustomerid"] = new EntityReference("account", rootId) },
                new Entity("contact", Guid.NewGuid()) { ["parentcustomerid"] = new EntityReference("account", rootId) },
            });
            var service = ctx.GetOrganizationService();

            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new HashSet<Guid> { childCfgId });
            var cache = new QueryResultCache();
            var diag = new RunDiagnostics();

            new QueryExecutor(service, cache, configs, diag)
                .Execute(new Entity("account", rootId), plan);

            var node = diag.Nodes.Single(n => n.NodeId == childCfgId);
            Assert.Equal(1, node.RetrieveMultipleCount);
            Assert.Equal(2, node.Rows);
            Assert.Equal(1, diag.RetrieveMultipleCount);
        }
    }
}
