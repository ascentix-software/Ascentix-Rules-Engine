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
        private static readonly Guid Outcome = Guid.NewGuid();

        private static Dictionary<Guid, bool> Outcomes(bool passed) => new Dictionary<Guid, bool> { [Outcome] = passed };

        private static RuleAction Action(ActionType type, ActionConditionGroup when,
            bool active = true, int order = 0, string message = null) =>
            new RuleAction { ActionType = type, Condition = when, IsActive = active, Order = order, Message = message };

        [Fact]
        public void All_true_action_fires_when_the_outcome_passed_and_any_false_does_not()
        {
            var actions = new List<RuleAction>
            {
                Action(ActionType.ShowMessage, ActionTrees.AllTrue(Outcome), message: "all true"),
                Action(ActionType.Block, ActionTrees.AnyFalse(Outcome), message: "any false"),
            };
            var fired = ActionDispatcher.ComputeFiredActions(Outcomes(true), actions);
            Assert.Equal(new[] { "all true" }, fired.Select(a => a.Message).ToArray());
        }

        [Fact]
        public void Any_false_action_fires_when_the_outcome_failed_and_all_true_does_not()
        {
            var actions = new List<RuleAction>
            {
                Action(ActionType.ShowMessage, ActionTrees.AllTrue(Outcome), message: "all true"),
                Action(ActionType.Block, ActionTrees.AnyFalse(Outcome), message: "any false"),
            };
            var fired = ActionDispatcher.ComputeFiredActions(Outcomes(false), actions);
            Assert.Equal(new[] { "any false" }, fired.Select(a => a.Message).ToArray());
        }

        [Fact]
        public void Always_action_fires_whatever_the_outcomes()
        {
            var actions = new List<RuleAction> { Action(ActionType.ShowMessage, ActionTrees.Always()) };
            Assert.Single(ActionDispatcher.ComputeFiredActions(Outcomes(true), actions));
            Assert.Single(ActionDispatcher.ComputeFiredActions(Outcomes(false), actions));
            Assert.Single(ActionDispatcher.ComputeFiredActions(new Dictionary<Guid, bool>(), actions));
        }

        [Fact]
        public void Action_without_a_tree_never_fires()
        {
            var actions = new List<RuleAction> { Action(ActionType.Block, when: null) };
            Assert.Empty(ActionDispatcher.ComputeFiredActions(Outcomes(true), actions));
            Assert.Empty(ActionDispatcher.ComputeFiredActions(Outcomes(false), actions));
            Assert.Empty(ActionDispatcher.ComputeFiredActions(new Dictionary<Guid, bool>(), actions));
        }

        [Fact]
        public void Inactive_actions_never_fire()
        {
            var actions = new List<RuleAction>
            {
                Action(ActionType.Block, ActionTrees.AnyFalse(Outcome), active: false),
                Action(ActionType.ShowMessage, ActionTrees.Always(), active: false),
            };
            Assert.Empty(ActionDispatcher.ComputeFiredActions(Outcomes(false), actions));
        }

        [Fact]
        public void Fired_actions_are_ordered_by_order_and_stable_for_equal_orders()
        {
            var actions = new List<RuleAction>
            {
                Action(ActionType.Block, ActionTrees.AnyFalse(Outcome), order: 2, message: "second"),
                Action(ActionType.ShowMessage, ActionTrees.Always(), order: 1, message: "first"),
                Action(ActionType.ShowMessage, ActionTrees.AnyFalse(Outcome), order: 2, message: "third"),
                Action(ActionType.ShowMessage, ActionTrees.AllTrue(Outcome), order: 0, message: "skipped"),
            };
            var fired = ActionDispatcher.ComputeFiredActions(Outcomes(false), actions);
            Assert.Equal(new[] { "first", "second", "third" }, fired.Select(a => a.Message).ToArray());
        }

        [Fact]
        public void Blocking_messages_returns_blocksave_messages_in_order_with_fallback()
        {
            var fired = new List<RuleAction>
            {
                Action(ActionType.ShowMessage, ActionTrees.Always(), message: "not blocking"),
                Action(ActionType.Block, ActionTrees.Always(), message: "Name is required."),
                Action(ActionType.Block, ActionTrees.Always(), message: null),
            };
            var messages = ActionDispatcher.GetBlockingMessages(fired, 1033);
            Assert.Equal(new[] { "Name is required.", EngineStrings.DefaultBlockMessage(1033) }, messages.ToArray());
        }

        [Fact]
        public void ComputeFiredActions_with_null_actions_returns_empty()
        {
            Assert.Empty(ActionDispatcher.ComputeFiredActions(Outcomes(false), null));
            Assert.Empty(ActionDispatcher.ComputeFiredActions(Outcomes(true), null));
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
