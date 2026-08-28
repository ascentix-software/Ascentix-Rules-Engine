using Ascentix.RulesEngine.Plugin;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// PluginReentry.IsEngineInitiated distinguishes an engine-initiated write cascade
    /// (our own tagged write re-triggering us: suppress further writes) from a legitimate
    /// external trigger at any depth (another plugin/flow updating the record: apply writes).
    /// The marker is the SDK 'tag' shared variable, readable on the current context or up the
    /// ParentContext chain.
    /// </summary>
    public class PluginReentryTests
    {
        private static XrmFakedPluginExecutionContext Ctx() =>
            new XrmFakedPluginExecutionContext { SharedVariables = new ParameterCollection() };

        [Fact]
        public void False_when_no_tag_present()
        {
            Assert.False(PluginReentry.IsEngineInitiated(Ctx()));
        }

        [Fact]
        public void True_when_engine_tag_on_current_context()
        {
            var ctx = Ctx();
            ctx.SharedVariables["tag"] = PluginReentry.EngineWriteTag;
            Assert.True(PluginReentry.IsEngineInitiated(ctx));
        }

        [Fact]
        public void True_when_engine_tag_on_ancestor_context()
        {
            var parent = Ctx();
            parent.SharedVariables["tag"] = PluginReentry.EngineWriteTag;
            var child = Ctx();
            child.ParentContext = parent;
            Assert.True(PluginReentry.IsEngineInitiated(child));
        }

        [Fact]
        public void False_when_tag_is_a_different_value()
        {
            var ctx = Ctx();
            ctx.SharedVariables["tag"] = "someone-elses-tag";
            Assert.False(PluginReentry.IsEngineInitiated(ctx));
        }
    }
}
