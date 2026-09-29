using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeItEasy;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>The Create-target probe: the config chains that tell Create per row from a
    /// one-record Create, loaded apart from the rule's tree and never failing the save.</summary>
    public class TableConfigLoaderCreateTargetsTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static RuleAction Create(Guid? target, bool active = true) => new RuleAction
        { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, IsActive = active, TargetNodeId = target, TargetTable = "task" };

        [Fact]
        public void A_collection_target_is_a_set_and_a_missing_node_is_not_and_does_not_throw()
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid(); var goneId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), childId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "contact",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "parentcustomerid",
                },
            });
            var perRow = Create(childId); var stale = Create(goneId);

            var tree = new TableConfigLoader(ctx.GetOrganizationService()).LoadCreateTargets(new[] { perRow, stale });

            Assert.True(SetActions.IsSetAction(perRow, tree));
            Assert.False(SetActions.IsSetAction(stale, tree));
        }

        [Fact]
        public void Nothing_is_queried_when_no_active_create_carries_a_target()
        {
            var service = A.Fake<IOrganizationService>();
            var update = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, IsActive = true, TargetNodeId = Guid.NewGuid() };

            var tree = new TableConfigLoader(service).LoadCreateTargets(new[] { Create(null), Create(Guid.NewGuid(), active: false), update });

            Assert.Equal(0, tree.Count);
            A.CallTo(() => service.RetrieveMultiple(A<QueryBase>._)).MustNotHaveHappened();
        }
    }
}
