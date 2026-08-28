using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Pre-operation gate on asx_rule Update. When a rule transitions Draft→Published, runs the
    /// shared RuleValidator and blocks the save (throws) if the rule is invalid. Register on
    /// asx_rule Update, pre-operation synchronous, with a "PreImage" pre-image carrying statuscode.
    /// Draft saves and non-status edits pass untouched.
    /// </summary>
    public class RulePublishPlugin : PluginBase
    {
        public RulePublishPlugin() : base(typeof(RulePublishPlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var service = localPluginContext.SystemUserService;

            if (!context.InputParameters.TryGetValue("Target", out var t) || !(t is Entity target)) return;

            Entity preImage = null;
            context.PreEntityImages?.TryGetValue("PreImage", out preImage);

            // A null/absent PreImage leaves oldStatus null (treated as non-Published): if the Target
            // transitions to Published we still validate (fail-closed): a misregistered step must not
            // let an invalid rule publish unchecked.
            var oldStatus = preImage?.GetAttributeValue<OptionSetValue>("statuscode")?.Value;
            var newStatus = target.Contains("statuscode")
                ? target.GetAttributeValue<OptionSetValue>("statuscode")?.Value
                : oldStatus;

            var published = (int)RuleStatus.Published;
            var isPublishTransition = newStatus == published && oldStatus != published;
            if (!isPublishTransition) return;

            var model = RuleValidationLoader.Load(service, target.Id);
            if (model == null) return; // nothing to validate

            var report = RuleValidator.Validate(model, new AttributeFlagsProvider(service));
            if (!report.IsValid)
                throw new InvalidPluginExecutionException(
                    "This rule can't be published until these problems are fixed:\n" +
                    ValidationReportSerializer.JoinErrors(report));

            // SEC gate (publisher-relative, fail-closed): a System-context rule with write actions
            // may only be published by a user holding the matching privilege at Global depth on
            // each target table. Otherwise an Author with config-table CRUD alone could delegate
            // org-wide writes to SYSTEM. InitiatingUserId: the human behind the publish, so an
            // impersonated publish can't launder the check.
            var secIssues = SecurityChecks.Check(
                model, new PublisherPrivilegeProvider(service, context.InitiatingUserId));
            var secReport = ValidationReport.From(secIssues);
            if (!secReport.IsValid)
                throw new InvalidPluginExecutionException(
                    "This rule can't be published until these problems are fixed:\n" +
                    ValidationReportSerializer.JoinErrors(secReport));
        }
    }
}
