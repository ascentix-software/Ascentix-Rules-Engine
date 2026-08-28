using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleActionLoaderTargetNodeTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private sealed class FakeService : IOrganizationService
        {
            private readonly Entity _action;
            public FakeService(Entity action) { _action = action; }
            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                var qe = (QueryExpression)query;
                return qe.EntityName == Q(SchemaNames.RuleAction.Entity)
                    ? new EntityCollection(new List<Entity> { _action })
                    : new EntityCollection(new List<Entity>());
            }
            // Unused members
            public Guid Create(Entity e) => throw new NotImplementedException();
            public Entity Retrieve(string n, Guid id, ColumnSet c) => throw new NotImplementedException();
            public void Update(Entity e) => throw new NotImplementedException();
            public void Delete(string n, Guid id) => throw new NotImplementedException();
            public OrganizationResponse Execute(OrganizationRequest r) => throw new NotImplementedException();
            public void Associate(string n, Guid id, Relationship r, EntityReferenceCollection c) => throw new NotImplementedException();
            public void Disassociate(string n, Guid id, Relationship r, EntityReferenceCollection c) => throw new NotImplementedException();
        }

        [Fact]
        public void Loads_target_node_id()
        {
            var ruleId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid());
            action[Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId);
            action[Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue(7); // DeleteRecord
            action[Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue(1);
            action[Q(SchemaNames.RuleAction.TargetNode)] =
                new EntityReference(Q(SchemaNames.TableConfig.Entity), nodeId);

            var result = new RuleActionLoader(new FakeService(action)).LoadActionsByRule(new[] { ruleId });

            Assert.Equal(nodeId, result[ruleId].Single().TargetNodeId);
        }
    }
}
