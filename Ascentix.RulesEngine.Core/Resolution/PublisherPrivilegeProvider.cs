using System;
using System.Collections.Generic;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Validation;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>
    /// Dataverse-backed IPublisherPrivilegeProvider. One RetrieveUserPrivilegesRequest for the
    /// user (all privilege ids incl. team-inherited, max depth per privilege across roles), then
    /// one privilege⋈privilegeobjecttypecodes query per distinct table, cached for this
    /// instance's lifetime (execution-scoped, no statics). The join is convention-free: custom
    /// tables get no reliable prv-name pattern, and accessright is a bitmask (Create=32768,
    /// Write=2, Delete=65536), so match with a mask test, never equality.
    /// </summary>
    public class PublisherPrivilegeProvider : IPublisherPrivilegeProvider
    {
        // LIVE SEMANTICS: privilege.accessright uses the PRIVILEGE table's own bit values,
        // which are NOT the SDK AccessRights enum. Observed live on a custom table's full
        // privilege set: Read=1, Write=2, Append=4,
        // AppendTo=16, CREATE=32 (AccessRights.CreateAccess is 32768, a different enum that
        // merely agrees on the other bits), Share=262144, Assign=524288, Delete=65536.
        private const int CreateMask = 32;    // privilege.accessright Create bit (NOT AccessRights.CreateAccess)
        private const int WriteMask = 2;      // agrees with AccessRights.WriteAccess
        private const int DeleteMask = 65536; // agrees with AccessRights.DeleteAccess

        private readonly IOrganizationService _service;
        private readonly Guid _userId;
        private Dictionary<Guid, PrivilegeDepth> _userPrivileges; // lazy: privilege id → max depth
        private readonly Dictionary<string, List<KeyValuePair<Guid, int>>> _tablePrivileges =
            new Dictionary<string, List<KeyValuePair<Guid, int>>>(StringComparer.OrdinalIgnoreCase);

        public PublisherPrivilegeProvider(IOrganizationService service, Guid userId)
        {
            _service = service ?? throw new ArgumentNullException(nameof(service));
            _userId = userId;
        }

        public bool HasGlobalPrivilege(string tableLogicalName, SystemWriteRight right)
        {
            if (string.IsNullOrWhiteSpace(tableLogicalName)) return false;

            var user = LoadUserPrivileges();
            var mask = MaskFor(right);
            foreach (var pair in LoadTablePrivileges(tableLogicalName))
            {
                if ((pair.Value & mask) == 0) continue;
                if (user.TryGetValue(pair.Key, out var depth) && depth == PrivilegeDepth.Global)
                    return true;
            }
            return false;
        }

        private static int MaskFor(SystemWriteRight right)
        {
            switch (right)
            {
                case SystemWriteRight.Create: return CreateMask;
                case SystemWriteRight.Delete: return DeleteMask;
                default: return WriteMask;
            }
        }

        private Dictionary<Guid, PrivilegeDepth> LoadUserPrivileges()
        {
            if (_userPrivileges != null) return _userPrivileges;

            var response = (RetrieveUserPrivilegesResponse)_service.Execute(
                new RetrieveUserPrivilegesRequest { UserId = _userId });

            var map = new Dictionary<Guid, PrivilegeDepth>();
            foreach (var rp in response.RolePrivileges ?? new RolePrivilege[0])
            {
                if (!map.TryGetValue(rp.PrivilegeId, out var existing) || rp.Depth > existing)
                    map[rp.PrivilegeId] = rp.Depth;
            }
            return _userPrivileges = map;
        }

        // All privileges applicable to a table, as (privilege id, accessright mask) pairs.
        // LIVE SEMANTICS: the privilegeobjecttypecodes.objecttypecode column is an Int32 OBJECT
        // TYPE CODE, not the logical name: a string condition throws FormatException
        // server-side, which the fail-closed caller turns into "no privilege" for EVERY
        // publisher, admins included.
        // Resolve the table's numeric code from metadata first, then join on the int.
        private List<KeyValuePair<Guid, int>> LoadTablePrivileges(string tableLogicalName)
        {
            if (_tablePrivileges.TryGetValue(tableLogicalName, out var cached)) return cached;

            var response = (Microsoft.Xrm.Sdk.Messages.RetrieveEntityResponse)_service.Execute(
                new Microsoft.Xrm.Sdk.Messages.RetrieveEntityRequest
                {
                    LogicalName = tableLogicalName,
                    EntityFilters = Microsoft.Xrm.Sdk.Metadata.EntityFilters.Entity,
                });
            var objectTypeCode = response.EntityMetadata?.ObjectTypeCode;
            if (objectTypeCode == null)
                return _tablePrivileges[tableLogicalName] = new List<KeyValuePair<Guid, int>>();

            var query = new QueryExpression("privilege")
            {
                ColumnSet = new ColumnSet("privilegeid", "accessright"),
            };
            var link = query.AddLink("privilegeobjecttypecodes", "privilegeid", "privilegeid");
            link.LinkCriteria.AddCondition("objecttypecode", ConditionOperator.Equal, objectTypeCode.Value);

            var rows = _service.RetrieveMultiple(query).Entities;
            var list = new List<KeyValuePair<Guid, int>>(rows.Count);
            foreach (var row in rows)
            {
                var mask = row.GetAttributeValue<int?>("accessright") ?? 0;
                list.Add(new KeyValuePair<Guid, int>(row.Id, mask));
            }
            return _tablePrivileges[tableLogicalName] = list;
        }
    }
}
