using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ChangeSetTests
    {
        private static readonly Guid C1 = Guid.NewGuid(), C2 = Guid.NewGuid(), Root = Guid.NewGuid();

        private static WriteIntent Update(string table, Guid id, int order, string column, object value,
            RuleEvaluationContext context = RuleEvaluationContext.User) => new WriteIntent
        {
            Operation = WriteOperation.Update, TargetTable = table, TargetId = id, Context = context,
            SourceActionOrder = order, SourceActionName = "a" + order,
            Values = new Dictionary<string, object> { [column] = value },
        };

        private static WriteIntent WithLoaded(WriteIntent intent, string column, object loaded)
        {
            intent.LoadedValues = intent.LoadedValues ?? new Dictionary<string, object>();
            intent.LoadedValues[column] = loaded;
            return intent;
        }

        private static WriteIntent Delete(string table, Guid id, int order) => new WriteIntent
        {
            Operation = WriteOperation.Delete, TargetTable = table, TargetId = id, Context = RuleEvaluationContext.User,
            SourceActionOrder = order,
        };

        private static WriteIntent Create(string table, int order) => new WriteIntent
        {
            Operation = WriteOperation.Create, TargetTable = table, TargetId = Guid.NewGuid(), Context = RuleEvaluationContext.User,
            SourceActionOrder = order,
            Values = new Dictionary<string, object> { ["subject"] = "Follow up" },
        };

        [Fact]
        public void Two_updates_of_one_record_merge_and_the_later_action_wins_per_column()
        {
            var first = Update("contact", C1, 1, "description", "one");
            first.Values["donotbulkemail"] = true;
            var second = Update("contact", C1, 2, "description", "two");

            var cs = ChangeSet.Build(new[] { second, first }); // resolution order reversed on purpose

            var write = Assert.Single(Assert.Single(cs.Batches).Writes);
            Assert.Equal("two", write.Values["description"]);
            Assert.Equal(true, write.Values["donotbulkemail"]);
            Assert.Equal(1, cs.Updates);
        }

        [Fact]
        public void Equal_action_order_falls_back_to_resolution_order()
        {
            var cs = ChangeSet.Build(new[] { Update("contact", C1, 1, "description", "early"), Update("contact", C1, 1, "description", "late") });
            Assert.Equal("late", cs.Batches.Single().Writes.Single().Values["description"]);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void An_update_and_a_delete_of_one_record_become_a_delete(bool deleteFirst)
        {
            var update = Update("task", C1, deleteFirst ? 2 : 1, "description", "x");
            var delete = Delete("task", C1, deleteFirst ? 1 : 2);

            var cs = ChangeSet.Build(new[] { update, delete });

            var batch = Assert.Single(cs.Batches);
            Assert.Equal(WriteOperation.Delete, batch.Operation);
            Assert.Single(batch.Writes);
            Assert.Equal((0, 0, 1), (cs.Creates, cs.Updates, cs.Deletes));
        }

        [Fact]
        public void Creates_never_merge()
        {
            var cs = ChangeSet.Build(new[] { Create("task", 1), Create("task", 1) });
            Assert.Equal(2, cs.Creates);
            Assert.Equal(2, cs.Batches.Single().Writes.Count);
        }

        [Fact]
        public void A_set_update_equal_to_the_loaded_value_is_skipped_and_counted_unchanged()
        {
            var same = WithLoaded(Update("contact", C1, 1, "donotbulkemail", true), "donotbulkemail", true);
            var changed = WithLoaded(Update("contact", C2, 1, "donotbulkemail", true), "donotbulkemail", false);

            var cs = ChangeSet.Build(new[] { same, changed });

            Assert.Equal(1, cs.Updates);
            Assert.Equal(1, cs.Unchanged);
            Assert.True(cs.IsUnchanged(same));
            Assert.False(cs.IsUnchanged(changed));
            Assert.Equal(C2, cs.Batches.Single().Writes.Single().Id);
        }

        [Fact]
        public void A_column_whose_loaded_value_is_unknown_counts_as_changed()
        {
            var cs = ChangeSet.Build(new[] { Update("contact", C1, 1, "donotbulkemail", true) }); // no LoadedValues
            Assert.Equal(1, cs.Updates);
            Assert.Equal(0, cs.Unchanged);
        }

        [Fact]
        public void An_always_write_update_is_sent_even_when_nothing_changed()
        {
            var single = WithLoaded(Update("contact", C1, 1, "donotbulkemail", true), "donotbulkemail", true);
            single.AlwaysWrite = true;
            Assert.Equal(1, ChangeSet.Build(new[] { single }).Updates);
        }

        [Fact]
        public void A_merged_update_with_any_always_write_intent_is_sent()
        {
            var fromSet = WithLoaded(Update("contact", C1, 1, "donotbulkemail", true), "donotbulkemail", true);
            var single = WithLoaded(Update("contact", C1, 2, "description", "x"), "description", "x");
            single.AlwaysWrite = true;

            var cs = ChangeSet.Build(new[] { fromSet, single });

            Assert.Equal(1, cs.Updates);
            Assert.Equal(0, cs.Unchanged);
        }

        [Fact]
        public void A_deactivate_merges_with_an_update_of_the_same_record()
        {
            var deactivate = new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = "task", TargetId = C1, Context = RuleEvaluationContext.User,
                SourceActionOrder = 1,
                Values = new Dictionary<string, object> { ["statecode"] = new OptionSetValue(1), ["statuscode"] = new OptionSetValue(5) },
            };
            var update = Update("task", C1, 2, "description", "closed by rule");

            var write = ChangeSet.Build(new[] { deactivate, update }).Batches.Single().Writes.Single();

            Assert.Equal(3, write.Values.Count);
        }

        [Fact]
        public void The_record_being_saved_is_updated_in_place_and_never_sent()
        {
            var rootUpdate = new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = "account", TargetId = Root, RootTargeted = true,
                SourceActionOrder = 1, AlwaysWrite = true, Values = new Dictionary<string, object> { ["description"] = "x" },
            };
            // A set row that IS the saved record (line-rooted siblings) joins the in-place values too.
            var sameRecordFromSet = Update("account", Root, 2, "numberofemployees", 5);

            var cs = ChangeSet.Build(new[] { rootUpdate, sameRecordFromSet }, new RootRecord("account", Root));

            Assert.Empty(cs.Batches);
            Assert.True(cs.HasRootInPlace);
            Assert.Equal("x", cs.RootInPlaceValues["description"]);
            Assert.Equal(5, cs.RootInPlaceValues["numberofemployees"]);
            Assert.Equal(0, cs.WriteCount);
        }

        [Fact]
        public void A_delete_of_the_record_being_created_wins_over_its_in_place_update()
        {
            // A Create message: the in-flight record has no id yet, so its RootRecord carries
            // Guid.Empty, and a set Delete over that same (not-yet-persisted) row resolves with
            // TargetId Guid.Empty too.
            var rootInPlace = new RootRecord("task", Guid.Empty);
            var inPlaceUpdate = new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = "task", TargetId = Guid.Empty, RootTargeted = true,
                Context = RuleEvaluationContext.User, SourceActionOrder = 1, AlwaysWrite = true,
                Values = new Dictionary<string, object> { ["description"] = "x" },
            };
            var deleteOfSameRow = new WriteIntent
            {
                Operation = WriteOperation.Delete, TargetTable = "task", TargetId = Guid.Empty,
                Context = RuleEvaluationContext.User, SourceActionOrder = 2,
            };

            var cs = ChangeSet.Build(new[] { inPlaceUpdate, deleteOfSameRow }, rootInPlace);

            Assert.False(cs.HasRootInPlace);
            Assert.Empty(cs.RootInPlaceValues);
            var batch = Assert.Single(cs.Batches);
            Assert.Equal(WriteOperation.Delete, batch.Operation);
            var write = Assert.Single(batch.Writes);
            Assert.Equal(Guid.Empty, write.Id);
            Assert.Equal(WriteOperation.Delete, write.Operation);
        }

        [Fact]
        public void Without_an_in_flight_target_a_root_update_is_an_ordinary_update_of_the_evaluated_record()
        {
            var rootUpdate = new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = "account", TargetId = null, RootTargeted = true,
                AlwaysWrite = true, Values = new Dictionary<string, object> { ["description"] = "x" },
            };

            var cs = ChangeSet.Build(new[] { rootUpdate }, rootInPlace: null, evaluatedRecordId: Root);

            Assert.Equal(Root, cs.Batches.Single().Writes.Single().Id);
            Assert.False(cs.HasRootInPlace);
        }

        [Fact]
        public void Batches_go_creates_then_updates_then_deletes_grouped_per_table_in_first_seen_order()
        {
            var cs = ChangeSet.Build(new[]
            {
                Delete("task", Guid.NewGuid(), 1),
                Update("contact", C1, 2, "description", "x"),
                Create("task", 3),
                Update("account", C2, 4, "description", "y"),
                Create("phonecall", 5),
                Update("contact", C2, 6, "description", "z"),
            });

            Assert.Equal(new[] { "Create task", "Create phonecall", "Update contact", "Update account", "Delete task" },
                cs.Batches.Select(b => $"{b.Operation} {b.Table}"));
            Assert.Equal(2, cs.Batches[2].Writes.Count);
        }

        [Fact]
        public void User_and_system_writes_to_one_record_stay_apart()
        {
            var cs = ChangeSet.Build(new[]
            {
                Update("contact", C1, 1, "description", "user", RuleEvaluationContext.User),
                Update("contact", C1, 2, "donotbulkemail", true, RuleEvaluationContext.System),
            });

            Assert.Equal(2, cs.Updates);
            Assert.Equal(new[] { RuleEvaluationContext.User, RuleEvaluationContext.System }, cs.Batches.Select(b => b.Context));
        }

        [Fact]
        public void The_error_label_is_the_first_contributing_action_or_its_id()
        {
            var unnamed = Update("contact", C1, 1, "description", "x");
            unnamed.SourceActionName = null;
            unnamed.SourceActionId = C2;
            Assert.Equal(C2.ToString(), ChangeSet.Build(new[] { unnamed }).Batches.Single().Writes.Single().ActionLabel);

            var named = Update("contact", C1, 1, "description", "x");
            named.SourceActionName = "Stop bulk email";
            Assert.Equal("Stop bulk email", ChangeSet.Build(new[] { named }).Batches.Single().Writes.Single().ActionLabel);
        }

        [Fact]
        public void For_record_reads_single_and_set_intents_of_every_fired_action()
        {
            var single = Update("account", Root, 1, "description", "x");
            single.AlwaysWrite = true;
            var record = new RecordEvaluationResult
            {
                RecordId = Root,
                FiredActions = new List<FiredActionResult>
                {
                    new FiredActionResult { ActionType = ActionType.UpdateRecord, WriteIntent = single },
                    new FiredActionResult { ActionType = ActionType.DeleteRecord, WriteIntents = new List<WriteIntent> { Delete("task", C1, 2), Delete("task", C2, 2) } },
                    new FiredActionResult { ActionType = ActionType.Block },
                },
            };

            var cs = ChangeSet.ForRecord(record);

            Assert.Equal((0, 1, 2), (cs.Creates, cs.Updates, cs.Deletes));
            Assert.True(record.FiredActions[1].IsSetAction);
            Assert.False(record.FiredActions[0].IsSetAction);
        }

        [Fact]
        public void Merged_counts_the_intents_folded_into_another_write()
        {
            var cs = ChangeSet.Build(new[]
            {
                Update("contact", C1, 1, "description", "a"), Update("contact", C1, 2, "jobtitle", "b"),
                Update("contact", C2, 3, "description", "c"), Create("task", 4), Create("task", 5),
            });
            Assert.Equal(1, cs.Merged);
        }

        [Fact]
        public void Merged_counts_every_in_place_update_after_the_first()
        {
            var cs = ChangeSet.Build(new[]
            {
                Update("account", Root, 1, "name", "a"), Update("account", Root, 2, "description", "b"),
                Update("account", Root, 3, "fax", "c"),
            }, new RootRecord("account", Root));
            Assert.True(cs.HasRootInPlace);
            Assert.Equal(2, cs.Merged);
        }

        private static (Guid, ChangeSet) Rec(params WriteIntent[] intents)
        {
            var id = Guid.NewGuid();
            return (id, ChangeSet.Build(intents, null, id));
        }

        [Fact]
        public void Same_row_updates_from_two_records_merge_and_the_later_record_wins()
        {
            var row = Guid.NewGuid();
            var a = Rec(Update("contact", row, 1, "jobtitle", "A"), Update("contact", row, 1, "telephone1", "1"));
            var b = Rec(Update("contact", row, 1, "jobtitle", "B"));
            var combined = ChangeSet.Combine(new[] { a, b });
            var write = Assert.Single(Assert.Single(combined.Batches).Writes);
            Assert.Equal("B", write.Values["jobtitle"]);
            Assert.Equal("1", write.Values["telephone1"]);
            Assert.Equal(new[] { a.Item1, b.Item1 }, combined.RecordsOf(write));
            Assert.Equal(1, combined.Updates);
        }

        [Fact]
        public void An_update_then_a_delete_of_one_row_across_records_is_a_delete()
        {
            var row = Guid.NewGuid();
            var combined = ChangeSet.Combine(new[] { Rec(Update("contact", row, 1, "jobtitle", "A")), Rec(Delete("contact", row, 1)) });
            var batch = Assert.Single(combined.Batches);
            Assert.Equal(WriteOperation.Delete, batch.Operation);
            Assert.Single(batch.Writes);
            Assert.Equal(1, combined.Deletes);
            Assert.Equal(0, combined.Updates);
        }

        [Fact]
        public void A_delete_then_an_update_of_one_row_across_records_stays_a_delete()
        {
            var row = Guid.NewGuid();
            var combined = ChangeSet.Combine(new[] { Rec(Delete("contact", row, 1)), Rec(Update("contact", row, 1, "jobtitle", "B")) });
            Assert.Equal(WriteOperation.Delete, Assert.Single(combined.Batches).Operation);
        }

        [Fact]
        public void Creates_never_merge_and_repeated_deletes_collapse()
        {
            var row = Guid.NewGuid();
            var combined = ChangeSet.Combine(new[]
            {
                Rec(Create("task", 1), Delete("contact", row, 2)),
                Rec(Create("task", 1), Delete("contact", row, 2)),
            });
            Assert.Equal(2, combined.Creates);
            Assert.Equal(1, combined.Deletes);
            Assert.Equal(new[] { WriteOperation.Create, WriteOperation.Delete }, combined.Batches.Select(b => b.Operation).ToArray());
        }

        [Fact]
        public void Unchanged_writes_stay_dropped_and_are_counted()
        {
            var row = Guid.NewGuid();
            var noOp = Rec(WithLoaded(Update("contact", row, 1, "jobtitle", "Same"), "jobtitle", "Same"));
            var real = Rec(Update("contact", Guid.NewGuid(), 1, "jobtitle", "New"));
            var combined = ChangeSet.Combine(new[] { noOp, real });
            Assert.Equal(1, combined.Updates);
            Assert.Equal(1, combined.Unchanged);
            Assert.Equal(new[] { real.Item1 }, combined.RecordsOf(Assert.Single(Assert.Single(combined.Batches).Writes)));
        }

        [Fact]
        public void Batches_follow_record_order_per_table_and_context()
        {
            var a = Rec(Update("contact", Guid.NewGuid(), 1, "jobtitle", "A"));
            var b = Rec(Update("account", Guid.NewGuid(), 1, "name", "B"));
            var c = Rec(Update("contact", Guid.NewGuid(), 1, "jobtitle", "C"));
            var combined = ChangeSet.Combine(new[] { a, b, c });
            Assert.Equal(new[] { "contact", "account" }, combined.Batches.Select(x => x.Table).ToArray());
            Assert.Equal(new object[] { "A", "C" }, combined.Batches[0].Writes.Select(w => w.Values["jobtitle"]).ToArray());
        }

        [Fact]
        public void A_combined_write_keeps_its_first_action_label_for_error_messages()
        {
            var row = Guid.NewGuid();
            var combined = ChangeSet.Combine(new[] { Rec(Update("contact", row, 1, "jobtitle", "A")), Rec(Update("contact", row, 2, "jobtitle", "B")) });
            Assert.Equal("a1", Assert.Single(Assert.Single(combined.Batches).Writes).ActionLabel);
        }
    }
}
