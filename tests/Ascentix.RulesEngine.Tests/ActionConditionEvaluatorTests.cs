using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ActionConditionEvaluatorTests
    {
        private static readonly Guid A = Guid.NewGuid(), B = Guid.NewGuid(), C = Guid.NewGuid();

        private static ActionConditionTest Is(Guid outcome, bool expected) =>
            new ActionConditionTest { Id = Guid.NewGuid(), OutcomeId = outcome, Expected = expected };

        private static ActionConditionGroup Group(LogicalOperator op, params object[] children)
        {
            var g = new ActionConditionGroup { Id = Guid.NewGuid(), LogicalOperator = op };
            foreach (var child in children)
                if (child is ActionConditionTest t) g.Tests.Add(t); else g.Groups.Add((ActionConditionGroup)child);
            return g;
        }

        private static Dictionary<Guid, bool> Outcomes(bool a, bool b, bool c) =>
            new Dictionary<Guid, bool> { [A] = a, [B] = b, [C] = c };

        [Theory]
        [InlineData(true, true, true)]
        [InlineData(true, false, false)]
        [InlineData(false, true, false)]
        public void All_needs_every_test(bool a, bool b, bool fires) =>
            Assert.Equal(fires, ActionConditionEvaluator.Fires(Group(LogicalOperator.And, Is(A, true), Is(B, true)), Outcomes(a, b, false)));

        [Theory]
        [InlineData(false, false, false)]
        [InlineData(true, false, true)]
        public void Any_needs_one_test(bool a, bool b, bool fires) =>
            Assert.Equal(fires, ActionConditionEvaluator.Fires(Group(LogicalOperator.Or, Is(A, true), Is(B, true)), Outcomes(a, b, false)));

        [Fact]
        public void A_test_can_expect_false() =>
            Assert.True(ActionConditionEvaluator.Fires(Group(LogicalOperator.And, Is(A, false)), Outcomes(false, false, false)));

        [Fact]
        public void Groups_nest()
        {
            // High value AND (At risk OR Critical case)
            var tree = Group(LogicalOperator.And, Is(A, true), Group(LogicalOperator.Or, Is(B, true), Is(C, true)));
            Assert.True(ActionConditionEvaluator.Fires(tree, Outcomes(true, false, true)));
            Assert.False(ActionConditionEvaluator.Fires(tree, Outcomes(true, false, false)));
            Assert.False(ActionConditionEvaluator.Fires(tree, Outcomes(false, true, true)));
        }

        [Fact]
        public void Empty_all_is_always_and_empty_any_is_never()
        {
            Assert.True(ActionConditionEvaluator.Fires(ActionConditionGroup.Always(), new Dictionary<Guid, bool>()));
            Assert.False(ActionConditionEvaluator.Fires(Group(LogicalOperator.Or), Outcomes(true, true, true)));
        }

        [Fact]
        public void A_test_of_an_unknown_or_missing_outcome_is_false()
        {
            Assert.False(ActionConditionEvaluator.Fires(Group(LogicalOperator.And, Is(Guid.NewGuid(), true)), Outcomes(true, true, true)));
            var missing = new ActionConditionTest { Id = Guid.NewGuid(), OutcomeId = null, Expected = false };
            var g = new ActionConditionGroup { LogicalOperator = LogicalOperator.And };
            g.Tests.Add(missing);
            Assert.False(ActionConditionEvaluator.Fires(g, Outcomes(false, false, false)));
        }

        [Fact]
        public void No_tree_never_fires() =>
            Assert.False(ActionConditionEvaluator.Fires(null, Outcomes(true, true, true)));
    }
}
