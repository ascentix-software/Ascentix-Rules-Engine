using System;
using System.Linq;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Environment-wide engine actions (asx_SyncSteps, applying data updates) need a System Administrator
    /// or System Customizer, recognised by the privilege only those roles hold. Fails closed: a missing
    /// privilege row means not granted.
    /// </summary>
    internal static class AdminPrivilege
    {
        public const string Name = "prvWriteSdkMessageProcessingStep";

        public static bool Has(IOrganizationService service, Guid userId)
        {
            var query = new QueryExpression("privilege") { ColumnSet = new ColumnSet("privilegeid"), TopCount = 1 };
            query.Criteria.AddCondition("name", ConditionOperator.Equal, Name);
            var privilege = service.RetrieveMultiple(query).Entities.FirstOrDefault();
            if (privilege == null) return false;
            var response = (RetrieveUserPrivilegesResponse)service.Execute(new RetrieveUserPrivilegesRequest { UserId = userId });
            return (response.RolePrivileges ?? new RolePrivilege[0]).Any(rp => rp.PrivilegeId == privilege.Id);
        }
    }
}
