using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using FakeXrmEasy;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Pins the LIVE shape of the privilege⋈privilegeobjecttypecodes join: objecttypecode is
    /// an Int32 OBJECT TYPE CODE, not a logical name.
    /// The fixture seeds int-typed rows exactly as live Dataverse stores them. A provider
    /// that filters by the logical-name string finds nothing here and fails these tests.
    /// </summary>
    public class PublisherPrivilegeProviderTests
    {
        private const int CustomerOtc = 10021; // sample_customer's numeric object type code
        // privilege.accessright's OWN bit values, as observed live: Create is 32,
        // NOT the SDK AccessRights.CreateAccess (32768). The fixture is a faithful replica of
        // a live table's full privilege set so an SDK-enum regression fails here.
        private const int LiveCreateBit = 32;

        private static readonly Guid UserId = Guid.NewGuid();
        private static readonly Guid CreatePrivilegeId = Guid.NewGuid();

        private static XrmFakedContext Seed()
        {
            var ctx = new XrmFakedContext();
            var seed = new List<Entity>();
            void Priv(Guid id, string name, int accessright)
            {
                seed.Add(new Entity("privilege", id) { ["name"] = name, ["accessright"] = accessright });
                seed.Add(new Entity("privilegeobjecttypecodes", Guid.NewGuid())
                {
                    ["privilegeid"] = new EntityReference("privilege", id),
                    ["objecttypecode"] = CustomerOtc, // Int32, as live Dataverse stores it
                });
            }
            // The live-observed set for a custom table (names + accessright bits verbatim).
            Priv(CreatePrivilegeId, "prvCreatesample_Customer", LiveCreateBit);
            Priv(Guid.NewGuid(), "prvReadsample_Customer", 1);
            Priv(Guid.NewGuid(), "prvWritesample_Customer", 2);
            Priv(Guid.NewGuid(), "prvAppendsample_Customer", 4);
            Priv(Guid.NewGuid(), "prvAppendTosample_Customer", 16);
            Priv(Guid.NewGuid(), "prvDeletesample_Customer", 65536);
            Priv(Guid.NewGuid(), "prvSharesample_Customer", 262144);
            Priv(Guid.NewGuid(), "prvAssignsample_Customer", 524288);
            ctx.Initialize(seed);

            // RetrieveEntityRequest → metadata carrying the numeric object type code.
            var metadata = new EntityMetadata { LogicalName = "sample_customer" };
            typeof(EntityMetadata).GetProperty(nameof(EntityMetadata.ObjectTypeCode))!
                .SetValue(metadata, (int?)CustomerOtc);
            ctx.AddExecutionMock<RetrieveEntityRequest>(req => new RetrieveEntityResponse
            {
                Results = new ParameterCollection { ["EntityMetadata"] = metadata },
            });
            return ctx;
        }

        private static void MockUserPrivileges(XrmFakedContext ctx, PrivilegeDepth? depth)
        {
            ctx.AddExecutionMock<RetrieveUserPrivilegesRequest>(req => new RetrieveUserPrivilegesResponse
            {
                Results = new ParameterCollection
                {
                    ["RolePrivileges"] = depth == null
                        ? new RolePrivilege[0]
                        : new[] { new RolePrivilege { PrivilegeId = CreatePrivilegeId, Depth = depth.Value } },
                },
            });
        }

        [Fact]
        public void Global_holder_passes_via_the_int_objecttypecode_join()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, PrivilegeDepth.Global);
            var provider = new PublisherPrivilegeProvider(ctx.GetOrganizationService(), UserId);
            Assert.True(provider.HasGlobalPrivilege("sample_customer", SystemWriteRight.Create));
        }

        [Fact]
        public void Basic_depth_is_not_global()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, PrivilegeDepth.Basic);
            var provider = new PublisherPrivilegeProvider(ctx.GetOrganizationService(), UserId);
            Assert.False(provider.HasGlobalPrivilege("sample_customer", SystemWriteRight.Create));
        }

        [Fact]
        public void No_privileges_at_all_is_denied()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, null);
            var provider = new PublisherPrivilegeProvider(ctx.GetOrganizationService(), UserId);
            Assert.False(provider.HasGlobalPrivilege("sample_customer", SystemWriteRight.Create));
        }

        [Fact]
        public void Write_mask_does_not_satisfy_a_create_check()
        {
            var ctx = Seed();
            MockUserPrivileges(ctx, PrivilegeDepth.Global);
            var provider = new PublisherPrivilegeProvider(ctx.GetOrganizationService(), UserId);
            // The seeded privilege carries the Create mask only.
            Assert.False(provider.HasGlobalPrivilege("sample_customer", SystemWriteRight.Delete));
        }
    }
}
