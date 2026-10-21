using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.Publication;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Pre-operation publication on asx_rule Update. Each explicit Published status write
    /// validates the saved draft and prepares a new immutable revision in the same transaction.
    /// </summary>
    public class RulePublishPlugin : PluginBase
    {
        private readonly IReadOnlyList<IDataUpdate> _updates;

        public RulePublishPlugin() : this(DataUpdateRegistry.All) { }

        /// <summary>Tests supply the data updates the publish gate checks.</summary>
        internal RulePublishPlugin(IReadOnlyList<IDataUpdate> updates) : base(typeof(RulePublishPlugin))
        {
            _updates = updates;
        }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var service = localPluginContext.SystemUserService;

            if (!context.InputParameters.TryGetValue("Target", out var t) || !(t is Entity target)) return;

            if (target.GetAttributeValue<OptionSetValue>("statuscode")?.Value != (int)RuleStatus.Published) return;

            RulePublication.Publish(context, service, target, _updates);
        }
    }
}
