using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.Publication;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_ValidateRule Custom API. Loads a rule by id
    /// (any status), validates it, and reports IsValid + Issues JSON. Non-enforcing: an invalid
    /// rule is data, never an exception. Throws only on argument/usage errors.
    /// </summary>
    public class ValidateRuleApi : PluginBase
    {
        public ValidateRuleApi() : base(typeof(ValidateRuleApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var service = localPluginContext.SystemUserService;

            var raw = context.InputParameters.TryGetValue("RuleId", out var v) ? v as string : null;
            if (string.IsNullOrWhiteSpace(raw))
                throw new InvalidPluginExecutionException("asx_ValidateRule: RuleId is required.");
            if (!Guid.TryParse(raw, out var ruleId))
                throw new InvalidPluginExecutionException($"asx_ValidateRule: RuleId '{raw}' is not a valid GUID.");

            PublicationCoordinator.Lock(service, context);
            var snapshot = RuleSnapshot.Capture(service, ruleId);
            var model = RuleValidationLoader.Load(new SnapshotService(service, snapshot), ruleId);
            if (model == null)
                throw new InvalidPluginExecutionException($"asx_ValidateRule: rule '{ruleId}' was not found.");

            var report = RuleValidator.Validate(model, new AttributeFlagsProvider(service));

            // SEC issues are publisher-relative: the SEC_SYSWRITE_REQ warning always surfaces the
            // Global-privilege requirement (so the editor shows it to everyone), while the blocking
            // SEC_SYSWRITE_PRIV error reflects the CALLER's own privileges. The hard failure is
            // re-evaluated for the actual publisher at publish time (RulePublishPlugin).
            var secIssues = SecurityChecks.Check(
                model, new PublisherPrivilegeProvider(service, context.InitiatingUserId));
            // TRAV_PUSHDOWN advisory (non-blocking): criteria that can't filter server-side.
            var pushdownIssues = PushdownChecks.Check(model);
            var combined = ValidationReport.From(report.Issues.Concat(secIssues).Concat(pushdownIssues));

            context.OutputParameters["IsValid"] = combined.IsValid;
            context.OutputParameters["Issues"] = ValidationReportSerializer.Serialize(combined);
            context.OutputParameters["DraftHash"] = snapshot.Hash();
        }
    }
}
