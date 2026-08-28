using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ActionDispatcherTests
    {
        private static RuleAction Action(ActionType type, ActionFireOn fireOn,
            bool active = true, int order = 0, string message = null) =>
            new RuleAction { ActionType = type, FireOn = fireOn, IsActive = active, Order = order, Message = message };

        [Fact]
        public void OnNoMatch_action_fires_when_rule_did_not_match()
        {
            var actions = new List<RuleAction> { Action(ActionType.Block, ActionFireOn.OnNoMatch) };
            var fired = ActionDispatcher.ComputeFiredActions(matched: false, actions);
            Assert.Single(fired);
        }

        [Fact]
        public void OnNoMatch_action_does_not_fire_when_rule_matched()
        {
            var actions = new List<RuleAction> { Action(ActionType.Block, ActionFireOn.OnNoMatch) };
            var fired = ActionDispatcher.ComputeFiredActions(matched: true, actions);
            Assert.Empty(fired);
        }

        [Fact]
        public void OnMatch_action_fires_only_when_rule_matched()
        {
            var actions = new List<RuleAction> { Action(ActionType.ShowMessage, ActionFireOn.OnMatch) };
            Assert.Single(ActionDispatcher.ComputeFiredActions(true, actions));
            Assert.Empty(ActionDispatcher.ComputeFiredActions(false, actions));
        }

        [Fact]
        public void Inactive_actions_never_fire()
        {
            var actions = new List<RuleAction> { Action(ActionType.Block, ActionFireOn.OnNoMatch, active: false) };
            Assert.Empty(ActionDispatcher.ComputeFiredActions(false, actions));
        }

        [Fact]
        public void Fired_actions_are_ordered_by_order()
        {
            var actions = new List<RuleAction>
            {
                Action(ActionType.Block, ActionFireOn.OnNoMatch, order: 2, message: "second"),
                Action(ActionType.ShowMessage, ActionFireOn.OnNoMatch, order: 1, message: "first"),
            };
            var fired = ActionDispatcher.ComputeFiredActions(false, actions);
            Assert.Equal(new[] { "first", "second" }, fired.Select(a => a.Message).ToArray());
        }

        [Fact]
        public void Blocking_messages_returns_blocksave_messages_in_order_with_fallback()
        {
            var fired = new List<RuleAction>
            {
                Action(ActionType.ShowMessage, ActionFireOn.OnNoMatch, message: "not blocking"),
                Action(ActionType.Block, ActionFireOn.OnNoMatch, message: "Name is required."),
                Action(ActionType.Block, ActionFireOn.OnNoMatch, message: null),
            };
            var messages = ActionDispatcher.GetBlockingMessages(fired, 1033);
            Assert.Equal(new[] { "Name is required.", EngineStrings.DefaultBlockMessage(1033) }, messages.ToArray());
        }

        [Fact]
        public void ComputeFiredActions_with_null_actions_returns_empty()
        {
            Assert.Empty(ActionDispatcher.ComputeFiredActions(false, null));
            Assert.Empty(ActionDispatcher.ComputeFiredActions(true, null));
        }

        [Fact]
        public void GetBlockingMessages_with_null_returns_empty()
        {
            Assert.Empty(ActionDispatcher.GetBlockingMessages(null, 1033));
        }

        [Fact]
        public void FormatBlockMessage_dedupes_and_bullets_with_header()
        {
            var msg = ActionDispatcher.FormatBlockMessage(new[]
            {
                "Name must be Valid.",
                "Amount must be positive.",
                "Name must be Valid.", // duplicate
            }, 1033);

            Assert.StartsWith("This record could not be saved:", msg);
            Assert.Contains("\n • Name must be Valid.", msg);
            Assert.Contains("\n • Amount must be positive.", msg);
            // Deduped: "Name must be Valid." bullet appears exactly once.
            Assert.Equal(1, CountOccurrences(msg, "• Name must be Valid."));
        }

        private static int CountOccurrences(string haystack, string needle)
        {
            int count = 0, i = 0;
            while ((i = haystack.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { count++; i += needle.Length; }
            return count;
        }
    }
}
