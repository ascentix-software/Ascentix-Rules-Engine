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

        [Fact]
        public void IsInsideMessage_is_false_with_no_parent_context()
        {
            Assert.False(PluginReentry.IsInsideMessage(Ctx(), "asx_ProcessRunPage"));
        }

        [Fact]
        public void IsInsideMessage_is_true_when_an_ancestors_message_matches_case_insensitively()
        {
            var grandparent = Ctx();
            grandparent.MessageName = "ASX_PROCESSRUNPAGE";
            var parent = Ctx();
            parent.ParentContext = grandparent;
            var child = Ctx();
            child.ParentContext = parent;

            Assert.True(PluginReentry.IsInsideMessage(child, "asx_ProcessRunPage"));
        }

        [Fact]
        public void IsInsideMessage_is_false_when_no_ancestor_matches()
        {
            var parent = Ctx();
            parent.MessageName = "asx_StartDueSchedules";
            var child = Ctx();
            child.ParentContext = parent;

            Assert.False(PluginReentry.IsInsideMessage(child, "asx_ProcessRunPage"));
        }

        [Fact]
        public void IsInsideMessage_ignores_the_current_contexts_own_message_name()
        {
            var ctx = Ctx();
            ctx.MessageName = "asx_ProcessRunPage";

            Assert.False(PluginReentry.IsInsideMessage(ctx, "asx_ProcessRunPage"));
        }
    }
}
