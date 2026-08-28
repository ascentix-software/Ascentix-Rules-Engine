using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Core.Localization
{
    /// <summary>
    /// Resolves the render language for engine messages:
    /// caller's UI language → org base language → 1033 (English).
    /// Shared by the plugin and the asx_RunRules Custom API.
    /// </summary>
    public static class LanguageResolver
    {
        public static int Resolve(IOrganizationService service, Guid initiatingUserId)
        {
            try
            {
                var us = new QueryExpression("usersettings") { ColumnSet = new ColumnSet("uilanguageid") };
                us.Criteria.AddCondition("systemuserid", ConditionOperator.Equal, initiatingUserId);
                var setting = service.RetrieveMultiple(us).Entities.FirstOrDefault();
                var ui = setting?.GetAttributeValue<int>("uilanguageid") ?? 0;
                if (ui != 0) return ui;
            }
            catch { /* fall through to org default */ }

            try
            {
                var org = new QueryExpression("organization") { ColumnSet = new ColumnSet("languagecode") };
                var o = service.RetrieveMultiple(org).Entities.FirstOrDefault();
                var lc = o?.GetAttributeValue<int>("languagecode") ?? 0;
                if (lc != 0) return lc;
            }
            catch { /* fall through to English */ }

            return 1033;
        }
    }
}
