using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleEvaluationOutcomeTests
    {
        private static FiredActionResult Block(Guid ruleId, string msg) => new FiredActionResult
        {
            RuleId = ruleId, ActionType = ActionType.Block,
            FireOn = ActionFireOn.OnNoMatch, Message = msg, Severity = Severity.Error
        };

        private static FiredActionResult Show(Guid ruleId, string col, bool val) => new FiredActionResult
        {
            RuleId = ruleId, ActionType = ActionType.SetVisible,
            FireOn = ActionFireOn.OnMatch, TargetColumn = col, Value = val
        };

        [Fact]
        public void IsValid_true_and_zero_count_when_no_block_fired()
        {
            var rec = new RecordEvaluationResult
            {
                RecordId = Guid.NewGuid(),
                FiredActions = new List<FiredActionResult> { Show(Guid.NewGuid(), "name", true) }
            };
            var outcome = new RuleEvaluationOutcome { Records = new List<RecordEvaluationResult> { rec } };

            Assert.True(outcome.IsValid);
            Assert.Equal(0, outcome.FailedRuleCount);
            Assert.Empty(outcome.BlockingMessages);
        }

        [Fact]
        public void Block_makes_invalid_and_counts_distinct_rules()
        {
            var r1 = Guid.NewGuid();
            var rec = new RecordEvaluationResult
            {
                RecordId = Guid.NewGuid(),
                FiredActions = new List<FiredActionResult>
                {
                    Block(r1, "Bad."),
                    Block(r1, "Bad."),                 // same rule, deduped in count
                    Block(Guid.NewGuid(), "Worse.")
                }
            };
            var outcome = new RuleEvaluationOutcome { Records = new List<RecordEvaluationResult> { rec } };

            Assert.False(outcome.IsValid);
            Assert.Equal(2, outcome.FailedRuleCount);
            Assert.Equal(new[] { "Bad.", "Worse." }, outcome.BlockingMessages.Distinct().ToArray());
            Assert.True(rec.HasBlock);
            Assert.Contains("Bad.", rec.BlockingMessages);
        }
    }
}
