using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin.Registration;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DataverseRegistrationEnvironmentTests
    {
        private const string PluginTypeName = "Ascentix.RulesEngine.Plugin.RulesEnginePlugin";

        private static (XrmFakedContext ctx, Guid pluginTypeId, Guid updateMsgId) Seed()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var updateMsgId = Guid.NewGuid();
            ctx.Initialize(new List<Entity>
            {
                new Entity("plugintype", pluginTypeId) { ["typename"] = PluginTypeName },
                new Entity("sdkmessage", updateMsgId) { ["name"] = "Update" },
            });
            return (ctx, pluginTypeId, updateMsgId);
        }

        [Fact]
        public void SupportsMessage_true_only_when_a_filter_row_exists_for_message_and_table()
        {
            var (ctx, _, updateMsgId) = Seed();
            var service = ctx.GetOrganizationService();
            service.Create(new Entity("sdkmessagefilter")   // adds to the already-seeded context
            {
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                ["primaryobjecttypecode"] = "account",
            });

            var env = new DataverseRegistrationEnvironment(service, PluginTypeName);

            Assert.True(env.SupportsMessage("Update", "account"));
            Assert.False(env.SupportsMessage("Update", "contact"));   // no filter for contact
        }

        [Fact]
        public void CreateStep_writes_a_step_with_message_filter_eventhandler_stage_mode_and_filtering()
        {
            var (ctx, pluginTypeId, updateMsgId) = Seed();
            var service = ctx.GetOrganizationService();
            var filterId = service.Create(new Entity("sdkmessagefilter")
            {
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                ["primaryobjecttypecode"] = "account",
            });

            var env = new DataverseRegistrationEnvironment(service, PluginTypeName);
            env.CreateStep(new StepRegistration
            {
                TableLogicalName = "account",
                MessageName = "Update",
                FilteringAttributes = "name,statuscode"
            });

            var step = ctx.CreateQuery("sdkmessageprocessingstep").Single();
            Assert.Equal(20, step.GetAttributeValue<OptionSetValue>("stage").Value);          // pre-operation
            Assert.Equal(0, step.GetAttributeValue<OptionSetValue>("mode").Value);            // synchronous
            Assert.Equal("name,statuscode", step.GetAttributeValue<string>("filteringattributes"));
            Assert.Equal(updateMsgId, step.GetAttributeValue<EntityReference>("sdkmessageid").Id);
            Assert.Equal(filterId, step.GetAttributeValue<EntityReference>("sdkmessagefilterid").Id);
            Assert.Equal(pluginTypeId, step.GetAttributeValue<EntityReference>("eventhandler").Id);
            Assert.Contains("account", step.GetAttributeValue<string>("name"));               // naming convention
        }

        [Fact]
        public void CreateStep_updates_the_new_step_so_single_saves_are_routed_to_it()
        {
            var (ctx, _, updateMsgId) = Seed();
            var inner = ctx.GetOrganizationService();
            inner.Create(new Entity("sdkmessagefilter")
            {
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                ["primaryobjecttypecode"] = "account",
            });
            var service = new UpdateRecordingService(inner);

            var env = new DataverseRegistrationEnvironment(service, PluginTypeName);
            env.CreateStep(new StepRegistration { TableLogicalName = "account", MessageName = "Update", FilteringAttributes = "name" });
            env.CreateStep(new StepRegistration { TableLogicalName = "account", MessageName = "Update" });

            var stepIds = ctx.CreateQuery("sdkmessageprocessingstep").Select(s => s.Id).ToList();
            Assert.Equal(2, stepIds.Count);
            Assert.Equal(stepIds.OrderBy(id => id), service.Updated
                .Where(e => e.LogicalName == "sdkmessageprocessingstep").Select(e => e.Id).OrderBy(id => id));
            // The update rewrites the value the create set; it changes nothing.
            Assert.Equal(new[] { "name", null }, service.Updated.Select(e => e.GetAttributeValue<string>("filteringattributes")));
            Assert.Equal(new[] { "name", null }, ctx.CreateQuery("sdkmessageprocessingstep")
                .AsEnumerable().Select(s => s.GetAttributeValue<string>("filteringattributes")).OrderBy(f => f == null));
        }

        private sealed class UpdateRecordingService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            public readonly List<Entity> Updated = new List<Entity>();
            public UpdateRecordingService(IOrganizationService inner) { _inner = inner; }
            public void Update(Entity e) { Updated.Add(e); _inner.Update(e); }
            public Guid Create(Entity e) => _inner.Create(e);
            public EntityCollection RetrieveMultiple(Microsoft.Xrm.Sdk.Query.QueryBase q) => _inner.RetrieveMultiple(q);
            public Entity Retrieve(string n, Guid id, Microsoft.Xrm.Sdk.Query.ColumnSet c) => _inner.Retrieve(n, id, c);
            public OrganizationResponse Execute(OrganizationRequest r) => _inner.Execute(r);
            public void Delete(string n, Guid id) => _inner.Delete(n, id);
            public void Associate(string n, Guid id, Relationship r, EntityReferenceCollection c) => _inner.Associate(n, id, r, c);
            public void Disassociate(string n, Guid id, Relationship r, EntityReferenceCollection c) => _inner.Disassociate(n, id, r, c);
        }

        [Fact]
        public void GetEngineSteps_returns_only_engine_owned_steps_for_the_table()
        {
            var (ctx, pluginTypeId, updateMsgId) = Seed();
            var service = ctx.GetOrganizationService();
            var filterAccount = service.Create(new Entity("sdkmessagefilter")
            {
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                ["primaryobjecttypecode"] = "account",
            });
            // An engine-owned step (named by convention, our plugintype, account filter):
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Ascentix.RulesEngine: account Update",
                ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                ["sdkmessagefilterid"] = new EntityReference("sdkmessagefilter", filterAccount),
                ["filteringattributes"] = "name",
            });
            // A foreign step on the same table (different plugintype) must be ignored:
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Someone Else: account Update",
                ["eventhandler"] = new EntityReference("plugintype", Guid.NewGuid()),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                ["sdkmessagefilterid"] = new EntityReference("sdkmessagefilter", filterAccount),
            });

            var env = new DataverseRegistrationEnvironment(service, PluginTypeName);
            var steps = env.GetEngineSteps("account");

            var only = Assert.Single(steps);
            Assert.Equal("Update", only.MessageName);
            Assert.Equal("name", only.FilteringAttributes);
        }

        [Fact]
        public void StepName_uses_the_engine_naming_convention()
        {
            Assert.Equal("Ascentix.RulesEngine: account Update",
                DataverseRegistrationEnvironment.StepName("account", "Update"));
        }

        [Fact]
        public void GetAllEngineSteps_requires_both_plugin_type_and_name_prefix()
        {
            var (ctx, pluginTypeId, updateMsgId) = Seed();
            var service = ctx.GetOrganizationService();
            // Ours: engine type + engine prefix (two tables).
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Ascentix.RulesEngine: account Update",
                ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
            });
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Ascentix.RulesEngine: contact Update",
                ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
            });
            // Same type, foreign name (e.g. a hand-registered custom step): excluded.
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Custom: account Update",
                ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
            });
            // Engine-looking name on a different plugin type: excluded.
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Ascentix.RulesEngine: account Update",
                ["eventhandler"] = new EntityReference("plugintype", Guid.NewGuid()),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
            });

            var env = new DataverseRegistrationEnvironment(service, PluginTypeName);
            var steps = env.GetAllEngineSteps();

            Assert.Equal(2, steps.Count);
            Assert.All(steps, s => Assert.StartsWith("Ascentix.RulesEngine: ", s.Name));
        }

        [Fact]
        public void Steps_report_deactivation_state_and_absent_statecode_counts_as_active()
        {
            // Initialize (not Create): FakeXrmEasy blocks setting statecode through Create.
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var updateMsgId = Guid.NewGuid();
            ctx.Initialize(new List<Entity>
            {
                new Entity("plugintype", pluginTypeId) { ["typename"] = PluginTypeName },
                new Entity("sdkmessage", updateMsgId) { ["name"] = "Update" },
                new Entity("sdkmessageprocessingstep", Guid.NewGuid())
                {
                    ["name"] = "Ascentix.RulesEngine: account Update",
                    ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                    ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                    ["statecode"] = new OptionSetValue(DataverseRegistrationEnvironment.StateDisabled),
                },
                new Entity("sdkmessageprocessingstep", Guid.NewGuid())
                {
                    ["name"] = "Ascentix.RulesEngine: contact Update",
                    ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                    ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                    // no statecode at all (fake-seeded row)
                },
            });

            var env = new DataverseRegistrationEnvironment(ctx.GetOrganizationService(), PluginTypeName);
            var steps = env.GetAllEngineSteps();

            Assert.False(steps.Single(s => s.Name.Contains("account")).IsActive);
            Assert.True(steps.Single(s => s.Name.Contains("contact")).IsActive);
        }

        [Fact]
        public void GetEngineSteps_finds_an_engine_step_that_has_no_message_filter()
        {
            var (ctx, pluginTypeId, updateMsgId) = Seed();
            var service = ctx.GetOrganizationService();
            // An engine-owned step with NO sdkmessagefilterid (the orphan scenario):
            service.Create(new Entity("sdkmessageprocessingstep")
            {
                ["name"] = "Ascentix.RulesEngine: account Update",
                ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
            });

            var env = new DataverseRegistrationEnvironment(service, PluginTypeName);
            var step = Assert.Single(env.GetEngineSteps("account"));
            Assert.Equal("Update", step.MessageName); // found and manageable despite no filter
        }
    }
}
