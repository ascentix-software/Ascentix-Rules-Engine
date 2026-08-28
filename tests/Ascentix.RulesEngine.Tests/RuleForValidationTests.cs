using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleForValidationTests
    {
        /// <summary>
        /// Builds a three-level tree:
        ///   root (1 condition)
        ///     └─ child (1 condition)
        ///          └─ grandchild (1 condition)
        /// </summary>
        private static RuleForValidation BuildNestedModel(
            out Guid rootId, out Guid childId, out Guid grandchildId,
            out Guid rootConditionId, out Guid childConditionId, out Guid grandchildConditionId)
        {
            rootId = Guid.NewGuid();
            childId = Guid.NewGuid();
            grandchildId = Guid.NewGuid();
            rootConditionId = Guid.NewGuid();
            childConditionId = Guid.NewGuid();
            grandchildConditionId = Guid.NewGuid();

            var grandchild = new ConditionGroup
            {
                Id = grandchildId,
                Conditions = new List<RuleCondition>
                {
                    new RuleCondition { Id = grandchildConditionId, ConditionGroupId = grandchildId },
                },
                ChildGroups = new List<ConditionGroup>(),
            };

            var child = new ConditionGroup
            {
                Id = childId,
                Conditions = new List<RuleCondition>
                {
                    new RuleCondition { Id = childConditionId, ConditionGroupId = childId },
                },
                ChildGroups = new List<ConditionGroup> { grandchild },
            };

            var root = new ConditionGroup
            {
                Id = rootId,
                Conditions = new List<RuleCondition>
                {
                    new RuleCondition { Id = rootConditionId, ConditionGroupId = rootId },
                },
                ChildGroups = new List<ConditionGroup> { child },
            };

            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                Groups = new List<ConditionGroup> { root },
            };
        }

        [Fact]
        public void AllGroups_flattens_nested_child_groups()
        {
            var model = BuildNestedModel(
                out var rootId, out var childId, out var grandchildId,
                out _, out _, out _);

            var all = model.AllGroups().ToList();

            // Three groups: root + child + grandchild
            Assert.Equal(3, all.Count);
            Assert.Contains(all, g => g.Id == rootId);
            Assert.Contains(all, g => g.Id == childId);
            Assert.Contains(all, g => g.Id == grandchildId);
        }

        [Fact]
        public void AllConditions_spans_nested_groups()
        {
            var model = BuildNestedModel(
                out _, out _, out _,
                out var rootConditionId, out var childConditionId, out var grandchildConditionId);

            var all = model.AllConditions().ToList();

            // One condition per group, three total
            Assert.Equal(3, all.Count);
            Assert.Contains(all, c => c.Id == rootConditionId);
            Assert.Contains(all, c => c.Id == childConditionId);
            Assert.Contains(all, c => c.Id == grandchildConditionId);
        }
    }
}
