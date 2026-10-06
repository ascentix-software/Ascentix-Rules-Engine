using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunRulesResultSerializerTests
    {
        private static WriteIntent SetRow(Guid id, bool loaded) => new WriteIntent
        {
            Operation = WriteOperation.Update, TargetTable = "contact", TargetId = id,
            Values = new Dictionary<string, object> { ["donotbulkemail"] = true },
            LoadedValues = new Dictionary<string, object> { ["donotbulkemail"] = loaded },
        };

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
                Message = "Name must be Valid.", Severity = Severity.Error
            }));

            Assert.Contains("\"actionType\":\"Block\"", json);
            Assert.DoesNotContain("fireOn", json);
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
                TargetColumn = "telephone1", Value = true
            }));

            Assert.Contains("\"actionType\":\"SetVisible\"", json);
            Assert.Contains("\"targetColumn\":\"telephone1\"", json);
            Assert.Contains("\"value\":true", json);
            Assert.Contains("\"message\":null", json);
            Assert.Contains("\"severity\":null", json);
        }

        [Fact]
        public void PreviousOfNodeId_serializes_as_previousOf_guid_and_is_absent_when_null()
        {
            var nodeId = Guid.NewGuid();
            var json = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.UpdateRecord,
                PreviousOfNodeId = nodeId
            }));
            Assert.Contains($"\"previousOf\":\"{nodeId}\"", json);

            var jsonWithoutPrevious = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.UpdateRecord,
                PreviousOfNodeId = null
            }));
            Assert.DoesNotContain("previousOf", jsonWithoutPrevious);
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
                                ActionType = ActionType.CreateRecord,
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

        [Fact]
        public void A_create_reports_a_null_targetId_even_though_the_intent_carries_the_engine_assigned_id()
        {
            // R5: the engine-assigned id on a Create intent is the ChangeSet's internal merge key
            // only; it never becomes the created record's id, so the dry run must not report it —
            // for both a single-record create and a set create.
            var singleJson = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                ActionType = ActionType.CreateRecord,
                WriteIntent = new WriteIntent { Operation = WriteOperation.Create, TargetTable = "task", TargetId = Guid.NewGuid() },
            }));
            Assert.Contains("\"targetId\":null", singleJson);

            var setJson = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                ActionType = ActionType.CreateRecord,
                WriteIntents = new List<WriteIntent>
                {
                    new WriteIntent { Operation = WriteOperation.Create, TargetTable = "task", TargetId = Guid.NewGuid() },
                },
            }));
            Assert.Contains("\"targetId\":null", setJson);
        }

        [Fact]
        public void A_set_action_reports_its_rows_count_and_unchanged_count()
        {
            var fired = new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.UpdateRecord,
                WriteIntents = new List<WriteIntent> { SetRow(Guid.NewGuid(), true), SetRow(Guid.NewGuid(), false), SetRow(Guid.NewGuid(), false) },
            };

            var json = RunRulesResultSerializer.Serialize(OutcomeWith(fired));

            Assert.Contains("\"writeCount\":3", json);
            Assert.Contains("\"unchangedCount\":1", json);
            Assert.Contains("\"writes\":[{\"operation\":\"Update\",\"targetTable\":\"contact\"", json);
            Assert.Contains("\"targetTable\":\"contact\"", json);
            Assert.DoesNotContain("\"write\":", json);
        }

        [Fact]
        public void A_set_action_with_no_rows_reports_an_empty_list()
        {
            var json = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.DeleteRecord, WriteIntents = new List<WriteIntent>(),
            }));
            Assert.Contains("\"writes\":[]", json);
            Assert.Contains("\"writeCount\":0", json);
        }

        [Fact]
        public void Only_the_first_100_rows_are_listed()
        {
            var rows = Enumerable.Range(0, 130).Select(_ => SetRow(Guid.NewGuid(), false)).ToList();
            var json = RunRulesResultSerializer.Serialize(OutcomeWith(new FiredActionResult
            {
                RuleId = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, WriteIntents = rows,
            }));
            Assert.Equal(100, System.Text.RegularExpressions.Regex.Matches(json, "\"operation\":\"Update\"").Count);
            Assert.Contains("\"writeCount\":130", json);
        }

        [Fact]
        public void The_change_set_summary_counts_after_merging()
        {
            var id = Guid.NewGuid();
            var outcome = OutcomeWith(
                new FiredActionResult { ActionType = ActionType.UpdateRecord, WriteIntents = new List<WriteIntent> { SetRow(id, false), SetRow(Guid.NewGuid(), true) } },
                new FiredActionResult { ActionType = ActionType.DeleteRecord, WriteIntents = new List<WriteIntent>
                    { new WriteIntent { Operation = WriteOperation.Delete, TargetTable = "contact", TargetId = id } } },
                new FiredActionResult { ActionType = ActionType.CreateRecord, WriteIntent = new WriteIntent
                    { Operation = WriteOperation.Create, TargetTable = "task", TargetId = Guid.NewGuid() } });

            Assert.Equal("{\"creates\":1,\"updates\":0,\"deletes\":1,\"unchanged\":1}", RunRulesResultSerializer.SerializeChangeSet(outcome));
        }

        [Fact]
        public void A_blocked_record_contributes_nothing_to_the_change_set()
        {
            var outcome = OutcomeWith(
                new FiredActionResult { ActionType = ActionType.Block, Message = "no" },
                new FiredActionResult { ActionType = ActionType.UpdateRecord, WriteIntents = new List<WriteIntent> { SetRow(Guid.NewGuid(), false) } });
            Assert.Equal("{\"creates\":0,\"updates\":0,\"deletes\":0,\"unchanged\":0}", RunRulesResultSerializer.SerializeChangeSet(outcome));
            Assert.Contains("\"writeCount\":1", RunRulesResultSerializer.Serialize(outcome));
        }
    }
}
