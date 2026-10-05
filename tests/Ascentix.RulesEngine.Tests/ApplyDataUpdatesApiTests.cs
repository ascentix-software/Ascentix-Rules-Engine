using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ApplyDataUpdatesApiTests
    {
        private static readonly Guid PrivilegeId = Guid.NewGuid();
        private static readonly Guid CallerId = Guid.NewGuid();

        private static XrmFakedContext Seed(bool admin)
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { new Entity("privilege", PrivilegeId) { ["name"] = SyncStepsApi.StepWritePrivilege } });
            var granted = admin ? new[] { PrivilegeId } : new Guid[0];
            ctx.AddExecutionMock<RetrieveUserPrivilegesRequest>(req => new RetrieveUserPrivilegesResponse
            {
                Results = new ParameterCollection
                {
                    ["RolePrivileges"] = granted.Select(id => new RolePrivilege { PrivilegeId = id, Depth = PrivilegeDepth.Global }).ToArray(),
                },
            });
            return ctx;
        }

        private static XrmFakedPluginExecutionContext Call(params (string Key, object Value)[] inputs)
        {
            var input = new ParameterCollection();
            foreach (var (key, value) in inputs) input[key] = value;
            return new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_" + SchemaNames.ApplyDataUpdatesApi.MessageName,
                Stage = 30,
                InitiatingUserId = CallerId,
                UserId = CallerId,
                InputParameters = input,
                OutputParameters = new ParameterCollection(),
            };
        }

        [Fact]
        public void Status_reports_nothing_pending_and_whether_the_caller_can_apply()
        {
            var ctx = Seed(admin: false);
            var call = Call((SchemaNames.ApplyDataUpdatesApi.ParamMode, "Status"));
            ctx.ExecutePluginWith<ApplyDataUpdatesApi>(call);

            Assert.Equal(0, call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropRequired]);
            Assert.Equal("[]", call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropPending]);
            Assert.Equal("null", call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropLatest]);
            Assert.False((bool)call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropCanApply]);
            Assert.True((bool)call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropDone]);
        }

        [Fact]
        public void Status_says_an_administrator_can_apply()
        {
            var ctx = Seed(admin: true);
            var call = Call((SchemaNames.ApplyDataUpdatesApi.ParamMode, "status"));
            ctx.ExecutePluginWith<ApplyDataUpdatesApi>(call);
            Assert.True((bool)call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropCanApply]);
        }

        [Fact]
        public void Apply_is_refused_for_a_caller_who_is_not_an_administrator()
        {
            var ctx = Seed(admin: false);
            var e = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ApplyDataUpdatesApi>(Call((SchemaNames.ApplyDataUpdatesApi.ParamMode, "Apply"))));
            Assert.Equal(ApplyDataUpdatesApi.NotAdminMessage, e.Message);
        }

        [Fact]
        public void Apply_with_no_updates_is_done()
        {
            var ctx = Seed(admin: true);
            var call = Call((SchemaNames.ApplyDataUpdatesApi.ParamMode, "Apply"), (SchemaNames.ApplyDataUpdatesApi.ParamFailedItem, ""));
            ctx.ExecutePluginWith<ApplyDataUpdatesApi>(call);
            Assert.True((bool)call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropDone]);
        }

        [Fact]
        public void A_retry_of_zero_means_no_retry()
        {
            // Dataverse passes an optional Integer parameter the caller left out as 0.
            var ctx = Seed(admin: true);
            var call = Call((SchemaNames.ApplyDataUpdatesApi.ParamMode, "Apply"), (SchemaNames.ApplyDataUpdatesApi.ParamRetry, 0));
            ctx.ExecutePluginWith<ApplyDataUpdatesApi>(call);
            Assert.True((bool)call.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropDone]);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("Run")]
        public void An_unknown_mode_is_refused(string mode)
        {
            var ctx = Seed(admin: true);
            var e = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ApplyDataUpdatesApi>(Call((SchemaNames.ApplyDataUpdatesApi.ParamMode, mode))));
            Assert.Contains("Expected Status or Apply", e.Message);
        }
    }
}
