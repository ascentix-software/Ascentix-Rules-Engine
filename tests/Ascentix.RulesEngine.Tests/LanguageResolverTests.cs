using System;
using Ascentix.RulesEngine.Core.Localization;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class LanguageResolverTests
    {
        [Fact]
        public void Falls_back_to_english_when_nothing_configured()
        {
            var ctx = new XrmFakedContext();
            var service = ctx.GetOrganizationService();
            Assert.Equal(1033, LanguageResolver.Resolve(service, Guid.NewGuid()));
        }

        [Fact]
        public void Uses_org_language_when_user_setting_absent()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(new[] { new Entity("organization", Guid.NewGuid()) { ["languagecode"] = 1036 } });
            var service = ctx.GetOrganizationService();
            // No usersettings row → user path yields 0 → falls through to org languagecode.
            Assert.Equal(1036, LanguageResolver.Resolve(service, Guid.NewGuid()));
        }
    }
}
