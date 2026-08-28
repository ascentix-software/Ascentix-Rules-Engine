using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin;
using FakeXrmEasy;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>The asx_SyncSteps API shell: the prvWriteSdkMessageProcessingStep gate
    /// (fail-closed, before any work) and Mode parsing.</summary>
    public class SyncStepsApiTests
    {
        private static readonly Guid PrivilegeId = Guid.NewGuid();
        private static readonly Guid CallerId = Guid.NewGuid();

        private static XrmFakedContext Seed(bool privilegeRowExists = true)
        {
            var ctx = new XrmFakedContext();
            var seed = new List<Entity>
            {
                new Entity("plugintype", Guid.NewGuid())
                {
                    ["typename"] = "Ascentix.RulesEngine.Plugin.RulesEnginePlugin"
                },
            };
            if (privilegeRowExists)
                seed.Add(new Entity("privilege", PrivilegeId) { ["name"] = SyncStepsApi.StepWritePrivilege });
            ctx.Initialize(seed);
            return ctx;
        }

        private static void MockUserPrivileges(XrmFakedContext ctx, params Guid[] privilegeIds)
        {
            ctx.AddExecutionMock<RetrieveUserPrivilegesRequest>(req => new RetrieveUserPrivilegesResponse
            {
                Results = new ParameterCollection
                {
                    ["RolePrivileges"] = privilegeIds
                        .Select(id => new RolePrivilege { PrivilegeId = id, Depth = PrivilegeDepth.Global })
                        .ToArray()
                }
            });
        }

        private static XrmFakedPluginExecutionContext ApiContext(string mode = null)
        {
            var input = new ParameterCollection();
            if (mode != null) input["Mode"] = mode;
            return new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_SyncSteps",
                InitiatingUserId = CallerId,
                UserId = CallerId,
                InputParameters = input,
                OutputParameters = new ParameterCollection(),
            };
        }

        [Fact]
        public void Caller_without_the_step_write_privilege_is_denied_by_name()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, Guid.NewGuid()); // some other privilege

            var pluginContext = ApiContext();
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => ctx.ExecutePluginWith<SyncStepsApi>(pluginContext));

            Assert.Contains("prvWriteSdkMessageProcessingStep", ex.Message);
            Assert.Contains("System Administrator or System Customizer", ex.Message);
        }

        [Fact]
        public void Missing_privilege_row_fails_closed()
        {
            var ctx = Seed(privilegeRowExists: false);
            MockUserPrivileges(ctx, PrivilegeId); // grants are irrelevant: row can't resolve

            Assert.Throws<InvalidPluginExecutionException>(
                () => ctx.ExecutePluginWith<SyncStepsApi>(ApiContext()));
        }

        [Fact]
        public void Gate_precedes_mode_validation()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx); // no privileges at all

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => ctx.ExecutePluginWith<SyncStepsApi>(ApiContext(mode: "Garbage")));

            Assert.Contains("cannot manage plug-in steps", ex.Message); // not the Mode error
        }

        [Fact]
        public void Unknown_mode_is_an_argument_error_for_a_privileged_caller()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, PrivilegeId);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => ctx.ExecutePluginWith<SyncStepsApi>(ApiContext(mode: "Garbage")));

            Assert.Contains("unknown Mode 'Garbage'", ex.Message);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("Sync")]
        [InlineData("sync")]
        [InlineData("REMOVEALL")]
        public void Empty_org_is_a_valid_noop_for_every_mode_spelling(string mode)
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, PrivilegeId);

            var pluginContext = ApiContext(mode);
            ctx.ExecutePluginWith<SyncStepsApi>(pluginContext);

            Assert.Equal(0, pluginContext.OutputParameters["TablesProcessed"]);
            Assert.Equal(0, pluginContext.OutputParameters["StepsCreated"]);
            Assert.Equal(0, pluginContext.OutputParameters["StepsDeleted"]);
            Assert.Equal(0, pluginContext.OutputParameters["DeactivatedStepsFound"]);
            Assert.Equal("[]", pluginContext.OutputParameters["Details"]);
        }
    }
}
