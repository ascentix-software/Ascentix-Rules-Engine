using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Plugin.Registration;
using Ascentix.RulesEngine.Plugin.Publication;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Keeps the customer-table SDK steps for RulesEnginePlugin in sync with rule
    /// configuration. Register (as shipped solution components) on asx_rule and
    /// asx_ruleaction, Create/Update/Delete, pre-operation synchronous, with a
    /// "PreImage" pre-image carrying the columns read below. All step CRUD runs as the
    /// system user; the security gate is the rule tables. See spec.
    /// </summary>
    public class RuleRegistrationPlugin : PluginBase
    {
        public const string RulesEnginePluginTypeName =
            "Ascentix.RulesEngine.Plugin.RulesEnginePlugin";

        private static readonly string RuleEntity = SchemaNames.Qualify(SchemaNames.Rule.Entity);
        private static readonly string RuleActionEntity = SchemaNames.Qualify(SchemaNames.RuleAction.Entity);
        private static readonly string RuleTableField = SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName);
        private static readonly string ActionRuleField = SchemaNames.Qualify(SchemaNames.RuleAction.Rule);
        private static readonly string RuleIdField = SchemaNames.PrimaryId(SchemaNames.DefaultPrefix, SchemaNames.Rule.Entity);

        public RuleRegistrationPlugin() : base(typeof(RuleRegistrationPlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            if (PublicationCoordinator.IsInternal(context, localPluginContext.SystemUserService)) return;
            // Registration writes system tables, so run as the system user.
            var service = localPluginContext.SystemUserService;
            var trace = localPluginContext.TracingService;

            var tables = AffectedTables(context, service, trace);
            if (tables.Count == 0) return;
            trace.Trace($"Affected tables: {string.Join(", ", tables)}");

            var env = new DataverseRegistrationEnvironment(service, RulesEnginePluginTypeName);
            var analyzer = new TableRuleAnalyzer(service);
            var change = InFlightChange.From(context);

            foreach (var table in tables)
            {
                var desired = StepPlanner.Plan(analyzer.Analyze(table, change));
                StepReconciler.Reconcile(env, table, desired);
                trace.Trace($"Reconciled steps for '{table}'.");
            }
        }

        /// <summary>The distinct tables whose step set may have changed.</summary>
        private HashSet<string> AffectedTables(
            IPluginExecutionContext context, IOrganizationService service, ITracingService trace)
        {
            var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var entity = context.PrimaryEntityName;

            context.InputParameters.TryGetValue("Target", out var target);
            Entity preImage = null;
            context.PreEntityImages?.TryGetValue("PreImage", out preImage);

            if (string.Equals(entity, RuleEntity, StringComparison.OrdinalIgnoreCase))
            {
                // New table (from Target) and old table (from pre-image): reconcile both.
                AddTable(tables, (target as Entity)?.GetAttributeValue<string>(RuleTableField));
                AddTable(tables, preImage?.GetAttributeValue<string>(RuleTableField));
            }
            else if (string.Equals(entity, RuleActionEntity, StringComparison.OrdinalIgnoreCase))
            {
                // Resolve the parent rule (from Target or pre-image) and reconcile its table.
                var ruleRef = (target as Entity)?.GetAttributeValue<EntityReference>(ActionRuleField)
                              ?? preImage?.GetAttributeValue<EntityReference>(ActionRuleField);
                AddTable(tables, RuleTableFor(service, ruleRef, trace));
            }

            return tables;
        }

        private static void AddTable(HashSet<string> tables, string table)
        {
            if (!string.IsNullOrWhiteSpace(table)) tables.Add(table);
        }

        // Looks up the parent rule's table via a query so a missing rule yields an
        // empty result (not a fault): the rule may have been cascade-deleted with the
        // action, in which case the rule Delete handler already reconciled its table.
        // Genuine service faults (transient, privilege) propagate and fail the save.
        private string RuleTableFor(IOrganizationService service, EntityReference ruleRef, ITracingService trace)
        {
            if (ruleRef == null) return null;

            var query = new QueryExpression(RuleEntity)
            {
                ColumnSet = new ColumnSet(RuleTableField),
                TopCount = 1
            };
            query.Criteria.AddCondition(RuleIdField, ConditionOperator.Equal, ruleRef.Id);

            var rule = service.RetrieveMultiple(query).Entities.FirstOrDefault();
            if (rule == null)
            {
                trace.Trace($"Parent rule {ruleRef.Id} not found, skipping (covered by rule delete).");
                return null;
            }
            return rule.GetAttributeValue<string>(RuleTableField);
        }
    }
}
