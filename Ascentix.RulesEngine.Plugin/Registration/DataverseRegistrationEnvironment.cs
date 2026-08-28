using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>
    /// IRegistrationEnvironment over a live IOrganizationService. Resolves the
    /// RulesEnginePlugin plugin type, messages, and (message, table) filters, and
    /// CRUDs sdkmessageprocessingstep rows. Engine-owned steps are identified by
    /// pointing at the plugin type, scoped to the table, with the naming convention.
    /// </summary>
    public class DataverseRegistrationEnvironment : IStepSyncEnvironment
    {
        public const int StagePreOperation = 20;
        public const int ModeSynchronous = 0;
        public const int StateDisabled = 1;              // sdkmessageprocessingstep statecode
        public const string StepNamePrefix = "Ascentix.RulesEngine: ";

        private readonly IOrganizationService _service;
        private readonly string _pluginTypeName;
        private Guid? _pluginTypeId;

        public DataverseRegistrationEnvironment(IOrganizationService service, string pluginTypeName)
        {
            _service = service;
            _pluginTypeName = pluginTypeName;
        }

        public static string StepName(string table, string message) =>
            $"{StepNamePrefix}{table} {message}";

        private Guid PluginTypeId
        {
            get
            {
                if (_pluginTypeId == null)
                {
                    _pluginTypeId = ResolveByAttribute("plugintype", "typename", _pluginTypeName, "plugintypeid")
                        ?? throw new InvalidOperationException(
                            $"Plugin type '{_pluginTypeName}' is not registered in Dataverse.");
                }
                return _pluginTypeId.Value;
            }
        }

        public bool SupportsMessage(string messageName, string table) =>
            FindMessageFilter(messageName, table) != null;

        public List<RegisteredStep> GetEngineSteps(string table)
        {
            // All steps registered to our plugin type, with their message name. Scope to
            // the table by our OWN naming convention ("Ascentix.RulesEngine: {table} ...")
            // rather than by joining sdkmessagefilter, so a step is always found and
            // managed even if its (message, table) filter is absent (no orphaning). The
            // sdkmessage link is safe to inner-join: sdkmessageid is a required column.
            var tablePrefix = StepName(table, string.Empty); // "Ascentix.RulesEngine: {table} "
            return QuerySteps(tablePrefix);
        }

        public List<RegisteredStep> GetAllEngineSteps() => QuerySteps(StepNamePrefix);

        private List<RegisteredStep> QuerySteps(string namePrefix)
        {
            var query = new QueryExpression("sdkmessageprocessingstep")
            {
                ColumnSet = new ColumnSet("sdkmessageprocessingstepid", "name", "filteringattributes", "statecode")
            };
            query.Criteria.AddCondition("eventhandler", ConditionOperator.Equal, PluginTypeId);

            var msg = query.AddLink("sdkmessage", "sdkmessageid", "sdkmessageid");
            msg.Columns = new ColumnSet("name");
            msg.EntityAlias = "msg";

            return _service.RetrieveMultiple(query).Entities
                .Where(e => (e.GetAttributeValue<string>("name") ?? "")
                    .StartsWith(namePrefix, StringComparison.Ordinal))
                .Select(e => new RegisteredStep
                {
                    Id = e.Id,
                    Name = e.GetAttributeValue<string>("name"),
                    MessageName = (e.GetAttributeValue<AliasedValue>("msg.name")?.Value as string),
                    FilteringAttributes = e.GetAttributeValue<string>("filteringattributes"),
                    // Absent statecode (test fakes) = active; real Dataverse always returns it.
                    IsActive = e.GetAttributeValue<OptionSetValue>("statecode")?.Value != StateDisabled
                })
                .ToList();
        }

        public void CreateStep(StepRegistration reg)
        {
            var messageId = ResolveByAttribute("sdkmessage", "name", reg.MessageName, "sdkmessageid")
                ?? throw new InvalidOperationException($"SDK message '{reg.MessageName}' not found in Dataverse.");
            var filterId = FindMessageFilter(reg.MessageName, reg.TableLogicalName);

            var step = new Entity("sdkmessageprocessingstep")
            {
                ["name"] = StepName(reg.TableLogicalName, reg.MessageName),
                ["sdkmessageid"] = new EntityReference("sdkmessage", messageId),
                ["eventhandler"] = new EntityReference("plugintype", PluginTypeId),
                ["stage"] = new OptionSetValue(StagePreOperation),
                ["mode"] = new OptionSetValue(ModeSynchronous),
                ["rank"] = 1,
            };
            if (filterId.HasValue)
                step["sdkmessagefilterid"] = new EntityReference("sdkmessagefilter", filterId.Value);
            if (!string.IsNullOrEmpty(reg.FilteringAttributes))
                step["filteringattributes"] = reg.FilteringAttributes;

            _service.Create(step);
        }

        public void UpdateFilteringAttributes(Guid stepId, string filteringAttributes)
        {
            _service.Update(new Entity("sdkmessageprocessingstep", stepId)
            {
                ["filteringattributes"] = filteringAttributes // null clears it (fire on all)
            });
        }

        public void DeleteStep(Guid stepId) =>
            _service.Delete("sdkmessageprocessingstep", stepId);

        // ── helpers ───────────────────────────────────────────────────────────

        private Guid? FindMessageFilter(string messageName, string table)
        {
            var messageId = ResolveByAttribute("sdkmessage", "name", messageName, "sdkmessageid");
            if (messageId == null) return null;

            var query = new QueryExpression("sdkmessagefilter")
            {
                ColumnSet = new ColumnSet("sdkmessagefilterid"),
                TopCount = 1
            };
            query.Criteria.AddCondition("sdkmessageid", ConditionOperator.Equal, messageId.Value);
            query.Criteria.AddCondition("primaryobjecttypecode", ConditionOperator.Equal, table);

            return _service.RetrieveMultiple(query).Entities.FirstOrDefault()?.Id;
        }

        private Guid? ResolveByAttribute(string entity, string attribute, string value, string idColumn)
        {
            var query = new QueryExpression(entity)
            {
                ColumnSet = new ColumnSet(idColumn),
                TopCount = 1
            };
            query.Criteria.AddCondition(attribute, ConditionOperator.Equal, value);
            return _service.RetrieveMultiple(query).Entities.FirstOrDefault()?.Id;
        }
    }
}
