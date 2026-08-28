using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunRulesResultSerializerTests
    {
        private static RuleEvaluationOutcome OutcomeWith(params FiredActionResult[] actions)
        {
            return new RuleEvaluationOutcome
            {
                Records = new List<RecordEvaluationResult>
                {
                    new RecordEvaluationResult { RecordId = Guid.NewGuid(), FiredActions = new List<FiredActionResult>(actions) }
                }
            };
        }

        [Fact]
        public void Empty_outcome_serializes_to_empty_array()
        {
            var json = RunRulesResultSerializer.Serialize(OutcomeWith());
            Assert.Equal("[]", json);
        }

        [Fact]
        public void Block_action_serializes_with_string_enums_and_null_value()
        {
            var json = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.Block,
                FireOn = ActionFireOn.OnNoMatch, Message = "Name must be Valid.", Severity = Severity.Error
            }));

            Assert.Contains("\"actionType\":\"Block\"", json);
            Assert.Contains("\"fireOn\":\"OnNoMatch\"", json);
            Assert.Contains("\"severity\":\"Error\"", json);
            Assert.Contains("\"message\":\"Name must be Valid.\"", json);
            Assert.Contains("\"value\":null", json);
        }

        [Fact]
        public void SetVisible_action_serializes_value_and_null_message()
        {
            var json = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.SetVisible,
                FireOn = ActionFireOn.OnMatch, TargetColumn = "telephone1", Value = true
            }));

            Assert.Contains("\"actionType\":\"SetVisible\"", json);
            Assert.Contains("\"targetColumn\":\"telephone1\"", json);
            Assert.Contains("\"value\":true", json);
            Assert.Contains("\"message\":null", json);
            Assert.Contains("\"severity\":null", json);
        }

        [Fact]
        public void Serializes_write_intent_for_create_action()
        {
            var outcome = new RuleEvaluationOutcome
            {
                Records = new System.Collections.Generic.List<RecordEvaluationResult>
                {
                    new RecordEvaluationResult
                    {
                        RecordId = System.Guid.NewGuid(),
                        FiredActions = new System.Collections.Generic.List<FiredActionResult>
                        {
                            new FiredActionResult
                            {
                                ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch,
                                WriteIntent = new WriteIntent
                                {
                                    Operation = WriteOperation.Create, TargetTable = "task",
                                    Values = new System.Collections.Generic.Dictionary<string, object>
                                    {
                                        ["subject"] = "Hi", ["statuscode"] = new OptionSetValue(2)
                                    }
                                }
                            }
                        }
                    }
                }
            };

            var json = RunRulesResultSerializer.Serialize(outcome);

            Assert.Contains("\"operation\":\"Create\"", json);
            Assert.Contains("\"targetTable\":\"task\"", json);
            Assert.Contains("\"subject\":\"Hi\"", json);
            Assert.Contains("\"statuscode\":2", json);   // OptionSetValue → int
        }
    }
}
