using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Plugin.Registration;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_SyncSteps Custom API. Mode=Sync
    /// reconciles every table's engine steps against rule configuration (drift
    /// recovery + orphan cleanup);
    /// Mode=RemoveAll deletes all engine-owned steps (pre-uninstall cleanup). Gated on
    /// the initiating user holding prvWriteSdkMessageProcessingStep, callers who could
    /// already manage these steps by hand; the CRUD itself runs as the system user,
    /// same as RuleRegistrationPlugin.
    /// </summary>
    public class SyncStepsApi : PluginBase
    {
        public const string StepWritePrivilege = "prvWriteSdkMessageProcessingStep";

        private static readonly string RuleEntity = SchemaNames.Qualify(SchemaNames.Rule.Entity);
        private static readonly string RuleTableField = SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName);

        public SyncStepsApi() : base(typeof(SyncStepsApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var service = localPluginContext.SystemUserService;
            var trace = localPluginContext.TracingService;

            // Gate before anything else, including Mode validation.
            RequireStepWritePrivilege(service, context.InitiatingUserId);

            var removeAll = ParseMode(GetString(context, "Mode"));
            var env = new DataverseRegistrationEnvironment(
                service, RuleRegistrationPlugin.RulesEnginePluginTypeName);

            SyncOutcome outcome;
            if (removeAll)
            {
                outcome = StepSyncService.RemoveAll(env);
            }
            else
            {
                var analyzer = new TableRuleAnalyzer(service);
                outcome = StepSyncService.Sync(
                    RuleTables(service), env,
                    table => StepPlanner.Plan(analyzer.Analyze(table, change: null)));
            }

            trace.Trace($"asx_SyncSteps {(removeAll ? "RemoveAll" : "Sync")}: " +
                $"{outcome.TablesProcessed} table(s), +{outcome.StepsCreated} ~{outcome.StepsUpdated} " +
                $"-{outcome.StepsDeleted}, {outcome.DeactivatedStepsFound} deactivated left alone.");

            context.OutputParameters["TablesProcessed"] = outcome.TablesProcessed;
            context.OutputParameters["StepsCreated"] = outcome.StepsCreated;
            context.OutputParameters["StepsUpdated"] = outcome.StepsUpdated;
            context.OutputParameters["StepsDeleted"] = outcome.StepsDeleted;
            context.OutputParameters["DeactivatedStepsFound"] = outcome.DeactivatedStepsFound;
            context.OutputParameters["Details"] = outcome.DetailsJson();
        }

        private static string GetString(IPluginExecutionContext context, string name)
            => context.InputParameters.TryGetValue(name, out var v) ? v as string : null;

        // Default Sync; case-insensitive; anything else is an argument error.
        private static bool ParseMode(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return false;
            var mode = raw.Trim();
            if (mode.Equals("Sync", StringComparison.OrdinalIgnoreCase)) return false;
            if (mode.Equals("RemoveAll", StringComparison.OrdinalIgnoreCase)) return true;
            throw new InvalidPluginExecutionException(
                $"asx_SyncSteps: unknown Mode '{raw}'. Expected Sync or RemoveAll.");
        }

        // Fail-closed: a missing privilege row denies like a missing grant.
        private static void RequireStepWritePrivilege(IOrganizationService service, Guid userId)
        {
            var query = new QueryExpression("privilege")
            {
                ColumnSet = new ColumnSet("privilegeid"),
                TopCount = 1
            };
            query.Criteria.AddCondition("name", ConditionOperator.Equal, StepWritePrivilege);
            var privilege = service.RetrieveMultiple(query).Entities.FirstOrDefault();

            var granted = false;
            if (privilege != null)
            {
                var response = (RetrieveUserPrivilegesResponse)service.Execute(
                    new RetrieveUserPrivilegesRequest { UserId = userId });
                granted = (response.RolePrivileges ?? new RolePrivilege[0])
                    .Any(rp => rp.PrivilegeId == privilege.Id);
            }

            if (!granted)
                throw new InvalidPluginExecutionException(
                    "asx_SyncSteps: the calling user cannot manage plug-in steps " +
                    $"({StepWritePrivilege}). A System Administrator or System Customizer must run this.");
        }

        // Distinct rule tables, any status. Desired steps are derived per table by the
        // analyzer/planner; this only decides WHICH tables to reconcile.
        private static IEnumerable<string> RuleTables(IOrganizationService service)
        {
            var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var query = new QueryExpression(RuleEntity)
            {
                ColumnSet = new ColumnSet(RuleTableField),
                PageInfo = new PagingInfo { PageNumber = 1, Count = 5000 }
            };
            while (true)
            {
                var page = service.RetrieveMultiple(query);
                foreach (var rule in page.Entities)
                {
                    var table = rule.GetAttributeValue<string>(RuleTableField);
                    if (!string.IsNullOrWhiteSpace(table)) tables.Add(table);
                }
                if (!page.MoreRecords) return tables;
                query.PageInfo.PageNumber++;
                query.PageInfo.PagingCookie = page.PagingCookie;
            }
        }
    }
}
