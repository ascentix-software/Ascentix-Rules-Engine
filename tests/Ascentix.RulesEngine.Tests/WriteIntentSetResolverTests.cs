using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class WriteIntentSetResolverTests
    {
        private sealed class FakeMetadata : IAttributeMetadataProvider, IOptionLabelProvider, IStatusMetadataProvider
        {
            public AttributeTypeCode? GetAttributeType(string table, string column)
            {
                switch (column)
                {
                    case "donotbulkemail": return AttributeTypeCode.Boolean;
                    case "regardingobjectid": case "objectid": return AttributeTypeCode.Lookup;
                    case "statuscode": return AttributeTypeCode.Status;
                    case "statecode": return AttributeTypeCode.State;
                    default: return AttributeTypeCode.String;
                }
            }
            public string GetOptionLabel(string table, string column, int value) => null;
            public int? GetDefaultStatus(string table, int state) => table == "task" && state == 1 ? 5 : (int?)null;
        }

        private static readonly DateTime Now = new DateTime(2026, 9, 29, 12, 0, 0, DateTimeKind.Utc);
        private static readonly Guid RootId = Guid.NewGuid(), OwnerId = Guid.NewGuid(), ContactsId = Guid.NewGuid(), TasksId = Guid.NewGuid();
        private static readonly Guid AccountId = Guid.NewGuid(), Ann = Guid.NewGuid(), Bob = Guid.NewGuid();

        private static TableConfigTree Tree() => TestTree.Tree(
            TestTree.Node(RootId, "account", TableConfigType.RootTable, null),
            TestTree.Node(OwnerId, "systemuser", TableConfigType.LookupTable, RootId),
            TestTree.Node(ContactsId, "contact", TableConfigType.ChildTable, RootId, "parentcustomerid"),
            TestTree.Node(TasksId, "task", TableConfigType.ChildTable, ContactsId, "regardingobjectid"));

        private static WriteIntentResolver Resolver() { var m = new FakeMetadata(); return new WriteIntentResolver(Tree(), m, m, Now); }
        private static Entity Root() => new Entity("account", AccountId) { ["name"] = "Acme" };

        private static QueryResultCache Cache(List<Entity> contacts, List<Entity> tasks = null) => TestTree.Cache(
            (RootId, new List<Entity> { Root() }),
            (ContactsId, contacts),
            (TasksId, tasks ?? new List<Entity>()));

        private static List<FieldMappingEntry> Map(string json) => FieldMappingParser.Parse(json);

        private static RuleAction Action(ActionType type, Guid? node, string mapping = null, NodeFilterGroup filter = null) => new RuleAction
        {
            Id = Guid.NewGuid(), Name = "Stop bulk email", Order = 3, ActionType = type, TargetNodeId = node,
            TargetTable = type == ActionType.CreateRecord ? "task" : null, FieldMapping = mapping, RowFilter = filter, IsActive = true,
        };

        private static NodeFilterGroup ActiveOnly(Guid node) => new NodeFilterGroup
        {
            TableConfigNodeId = node, LogicalOperator = LogicalOperator.And,
            Criteria = { new NodeFilterCriterion { FieldName = "statecode", Operator = "eq", Value = "0" } },
        };

        [Fact]
        public void A_set_update_resolves_one_intent_per_row_with_the_loaded_values()
        {
            var contacts = new List<Entity>
            {
                TestTree.Row("contact", Ann, ("donotbulkemail", true)),
                TestTree.Row("contact", Bob, ("donotbulkemail", false)),
            };
            const string mapping = "[{\"target\":\"donotbulkemail\",\"source\":\"literal\",\"value\":true}]";
            var action = Action(ActionType.UpdateRecord, ContactsId, mapping);

            var intents = Resolver().ResolveSet(action, Map(mapping), Root(), Cache(contacts), RuleEvaluationContext.User);

            Assert.Equal(new[] { Ann, Bob }, intents.Select(i => i.TargetId.Value));
            Assert.All(intents, i =>
            {
                Assert.Equal(WriteOperation.Update, i.Operation);
                Assert.Equal("contact", i.TargetTable);
                Assert.False(i.AlwaysWrite);
                Assert.False(i.RootTargeted);
                Assert.Equal(action.Id, i.SourceActionId);
                Assert.Equal("Stop bulk email", i.SourceActionName);
                Assert.Equal(3, i.SourceActionOrder);
                Assert.Equal(true, i.Values["donotbulkemail"]);
            });
            Assert.Equal(true, intents[0].LoadedValues["donotbulkemail"]);
            Assert.Equal(false, intents[1].LoadedValues["donotbulkemail"]);
        }

        [Fact]
        public void An_absent_column_on_a_fetched_row_is_loaded_as_null()
        {
            const string mapping = "[{\"target\":\"description\",\"source\":\"literal\",\"value\":\"x\"}]";
            var intents = Resolver().ResolveSet(Action(ActionType.UpdateRecord, ContactsId, mapping), Map(mapping), Root(),
                Cache(new List<Entity> { TestTree.Row("contact", Ann) }), RuleEvaluationContext.User);
            Assert.True(intents.Single().LoadedValues.ContainsKey("description"));
            Assert.Null(intents.Single().LoadedValues["description"]);
        }

        [Fact]
        public void The_rows_filter_keeps_only_matching_rows()
        {
            var contacts = new List<Entity>
            {
                TestTree.Row("contact", Ann, ("statecode", new OptionSetValue(0))),
                TestTree.Row("contact", Bob, ("statecode", new OptionSetValue(1))),
            };
            var action = Action(ActionType.DeleteRecord, ContactsId, filter: ActiveOnly(ContactsId));

            var intents = Resolver().ResolveSet(action, new List<FieldMappingEntry>(), Root(), Cache(contacts), RuleEvaluationContext.User);

            Assert.Equal(Ann, intents.Single().TargetId);
            Assert.Equal(WriteOperation.Delete, intents.Single().Operation);
        }

        [Fact]
        public void Zero_rows_resolve_to_no_intents()
        {
            var resolver = Resolver();
            // An empty collection.
            Assert.Empty(resolver.ResolveSet(Action(ActionType.DeleteRecord, ContactsId), new List<FieldMappingEntry>(), Root(),
                Cache(new List<Entity>()), RuleEvaluationContext.User));
            // A Rows filter that excludes every row: Create per row creates nothing.
            const string create = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"x\"}]";
            Assert.Empty(resolver.ResolveSet(Action(ActionType.CreateRecord, ContactsId, create, ActiveOnly(ContactsId)), Map(create), Root(),
                Cache(new List<Entity> { TestTree.Row("contact", Ann, ("statecode", new OptionSetValue(1))) }), RuleEvaluationContext.User));
        }

        [Fact]
        public void A_collection_under_a_collection_yields_every_row()
        {
            var tasks = new List<Entity>
            {
                TestTree.Row("task", Guid.NewGuid(), ("regardingobjectid", new EntityReference("contact", Ann))),
                TestTree.Row("task", Guid.NewGuid(), ("regardingobjectid", new EntityReference("contact", Bob))),
                TestTree.Row("task", Guid.NewGuid(), ("regardingobjectid", new EntityReference("contact", Bob))),
            };
            var intents = Resolver().ResolveSet(Action(ActionType.DeleteRecord, TasksId), new List<FieldMappingEntry>(), Root(),
                Cache(new List<Entity> { TestTree.Row("contact", Ann), TestTree.Row("contact", Bob) }, tasks), RuleEvaluationContext.User);
            Assert.Equal(3, intents.Count);
        }

        [Fact]
        public void Create_per_row_uses_the_current_row_source_and_row_tokens()
        {
            const string mapping = "[{\"target\":\"regardingobjectid\",\"source\":\"row\",\"column\":\"contactid\"}," +
                                   "{\"target\":\"subject\",\"source\":\"template\",\"template\":\"Credit hold follow-up – {row.fullname}\"}]";
            var contacts = new List<Entity> { TestTree.Row("contact", Ann, ("fullname", "Ann Lee")) };

            var intent = Resolver().ResolveSet(Action(ActionType.CreateRecord, ContactsId, mapping), Map(mapping), Root(), Cache(contacts),
                RuleEvaluationContext.System).Single();

            Assert.Equal(WriteOperation.Create, intent.Operation);
            Assert.Equal("task", intent.TargetTable);
            Assert.NotEqual(Guid.Empty, intent.TargetId.Value);
            Assert.Equal(RuleEvaluationContext.System, intent.Context);
            var regarding = Assert.IsType<EntityReference>(intent.Values["regardingobjectid"]);
            Assert.Equal(("contact", Ann), (regarding.LogicalName, regarding.Id));
            Assert.Equal("Credit hold follow-up – Ann Lee", intent.Values["subject"]);
        }

        [Fact]
        public void A_row_source_naming_an_activity_id_column_links_to_the_row()
        {
            var taskId = Guid.NewGuid();
            const string mapping = "[{\"target\":\"objectid\",\"source\":\"row\",\"column\":\"activityid\"}]";
            var tasks = new List<Entity> { TestTree.Row("task", taskId, ("activityid", taskId)) };
            var action = Action(ActionType.CreateRecord, TasksId, mapping);
            action.TargetTable = "annotation";

            var intent = Resolver().ResolveSet(action, Map(mapping), Root(), Cache(new List<Entity>(), tasks), RuleEvaluationContext.User).Single();

            var link = Assert.IsType<EntityReference>(intent.Values["objectid"]);
            Assert.Equal(("task", taskId), (link.LogicalName, link.Id));
        }

        [Fact]
        public void Deactivate_writes_state_1_and_the_default_inactive_status()
        {
            var tasks = new List<Entity> { TestTree.Row("task", Guid.NewGuid(), ("statecode", new OptionSetValue(0)), ("statuscode", new OptionSetValue(2))) };
            var intent = Resolver().ResolveSet(Action(ActionType.DeactivateRecord, TasksId), new List<FieldMappingEntry>(), Root(),
                Cache(new List<Entity>(), tasks), RuleEvaluationContext.User).Single();

            Assert.Equal(WriteOperation.Update, intent.Operation);
            Assert.Equal(1, ((OptionSetValue)intent.Values["statecode"]).Value);
            Assert.Equal(5, ((OptionSetValue)intent.Values["statuscode"]).Value);
            Assert.Equal(0, ((OptionSetValue)intent.LoadedValues["statecode"]).Value);
        }

        [Fact]
        public void Deactivate_uses_a_mapped_status_reason()
        {
            const string mapping = "[{\"target\":\"statuscode\",\"source\":\"literal\",\"value\":6}]";
            var tasks = new List<Entity> { TestTree.Row("task", Guid.NewGuid()) };
            var intent = Resolver().ResolveSet(Action(ActionType.DeactivateRecord, TasksId, mapping), Map(mapping), Root(),
                Cache(new List<Entity>(), tasks), RuleEvaluationContext.User).Single();
            Assert.Equal(6, ((OptionSetValue)intent.Values["statuscode"]).Value);
        }

        [Fact]
        public void A_single_deactivate_is_always_write_and_stamped()
        {
            var ownerRow = TestTree.Row("systemuser", Guid.NewGuid());
            var action = Action(ActionType.DeactivateRecord, OwnerId);
            var cache = TestTree.Cache((RootId, new List<Entity> { Root() }), (OwnerId, new List<Entity> { ownerRow }));
            var metadata = new FakeMetadataWithUserStatus();

            var intent = new WriteIntentResolver(Tree(), metadata, metadata, Now).Resolve(action, new List<FieldMappingEntry>(), Root(), cache, RuleEvaluationContext.User);

            Assert.True(intent.AlwaysWrite);
            Assert.Equal(action.Id, intent.SourceActionId);
            Assert.Equal(1, ((OptionSetValue)intent.Values["statecode"]).Value);
            Assert.Equal(2, ((OptionSetValue)intent.Values["statuscode"]).Value);
        }

        private sealed class FakeMetadataWithUserStatus : IAttributeMetadataProvider, IOptionLabelProvider, IStatusMetadataProvider
        {
            public AttributeTypeCode? GetAttributeType(string table, string column) => AttributeTypeCode.String;
            public string GetOptionLabel(string table, string column, int value) => null;
            public int? GetDefaultStatus(string table, int state) => state == 1 ? 2 : (int?)null;
        }

        [Fact]
        public void The_in_flight_row_has_unknown_loaded_values()
        {
            // Line-rooted: the triggering line is one of its order's lines (the reconciler adds it).
            Guid lineRoot = Guid.NewGuid(), order = Guid.NewGuid(), siblings = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(lineRoot, "sample_orderline", TableConfigType.RootTable, null),
                TestTree.Node(order, "sample_order", TableConfigType.LookupTable, lineRoot),
                TestTree.Node(siblings, "sample_orderline", TableConfigType.ChildTable, order, "sample_orderid"));
            var line = new Entity("sample_orderline", Guid.NewGuid());
            var other = new Entity("sample_orderline", Guid.NewGuid());
            var cache = TestTree.Cache((lineRoot, new List<Entity> { line }), (order, new List<Entity>()), (siblings, new List<Entity> { line, other }));
            const string mapping = "[{\"target\":\"sample_name\",\"source\":\"literal\",\"value\":\"x\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, TargetNodeId = siblings, IsActive = true };
            var m = new FakeMetadata();

            var intents = new WriteIntentResolver(tree, m, m, Now).ResolveSet(action, Map(mapping), line, cache, RuleEvaluationContext.User);

            Assert.Null(intents.Single(i => i.TargetId == line.Id).LoadedValues);
            Assert.NotNull(intents.Single(i => i.TargetId == other.Id).LoadedValues);
        }

        [Fact]
        public void A_row_that_is_the_record_being_created_is_root_targeted_not_a_separate_request()
        {
            // A Create message: the in-flight record has no id yet (Guid.Empty on both the root
            // and its copy in every sibling collection the reconciler adds it to). The set intent
            // for that sibling must merge into the change set's root-in-place values, not become a
            // separate Update request against Guid.Empty.
            Guid lineRoot = Guid.NewGuid(), order = Guid.NewGuid(), siblings = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(lineRoot, "sample_orderline", TableConfigType.RootTable, null),
                TestTree.Node(order, "sample_order", TableConfigType.LookupTable, lineRoot),
                TestTree.Node(siblings, "sample_orderline", TableConfigType.ChildTable, order, "sample_orderid"));
            var line = new Entity("sample_orderline"); // Id defaults to Guid.Empty: not yet created
            var other = new Entity("sample_orderline", Guid.NewGuid());
            var cache = TestTree.Cache((lineRoot, new List<Entity> { line }), (order, new List<Entity>()), (siblings, new List<Entity> { line, other }));
            const string mapping = "[{\"target\":\"sample_name\",\"source\":\"literal\",\"value\":\"x\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, TargetNodeId = siblings, IsActive = true };
            var m = new FakeMetadata();

            var intents = new WriteIntentResolver(tree, m, m, Now).ResolveSet(action, Map(mapping), line, cache, RuleEvaluationContext.User);

            var ownIntent = intents.Single(i => i.TargetId == Guid.Empty);
            Assert.True(ownIntent.RootTargeted);
            var otherIntent = intents.Single(i => i.TargetId == other.Id);
            Assert.False(otherIntent.RootTargeted);

            // The outcome the ruling names: no request is sent to Guid.Empty. The change set
            // merges the in-flight row's update into the record being created instead of batching
            // it as a separate write.
            var cs = ChangeSet.Build(intents, new RootRecord("sample_orderline", Guid.Empty));
            Assert.True(cs.HasRootInPlace);
            Assert.Equal("x", cs.RootInPlaceValues["sample_name"]);
            Assert.All(cs.Batches.SelectMany(b => b.Writes), w => Assert.NotEqual(Guid.Empty, w.Id));
        }

        [Theory]
        [InlineData(ActionType.UpdateRecord)]
        [InlineData(ActionType.DeleteRecord)]
        public void In_a_create_multiple_without_ids_only_the_evaluated_rows_own_copy_is_the_record_being_saved(ActionType type)
        {
            // Two lines created together, both Guid.Empty; the reconciler adds a copy of each into
            // the sibling collection. Evaluating the first line: its copy is the record being saved
            // (in place); the second line's copy has no id to write to and gets no intent.
            Guid lineRoot = Guid.NewGuid(), order = Guid.NewGuid(), siblings = Guid.NewGuid(), orderId = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(lineRoot, "sample_orderline", TableConfigType.RootTable, null),
                TestTree.Node(order, "sample_order", TableConfigType.LookupTable, lineRoot),
                TestTree.Node(siblings, "sample_orderline", TableConfigType.ChildTable, order, "sample_orderid"));
            Entity Line(string name) => new Entity("sample_orderline") { ["sample_name"] = name, ["sample_orderid"] = new EntityReference("sample_order", orderId) };
            var first = Line("First");
            var second = Line("Second");
            var persisted = new Entity("sample_orderline", Guid.NewGuid()) { ["sample_name"] = "Persisted" };
            var rows = new List<Entity> { persisted };
            var batch = new InFlightBatch { LogicalName = "sample_orderline", Operation = InFlightOperation.Create };
            batch.Records.Add(new InFlightRecord { Id = Guid.Empty, Target = first, Root = first });
            batch.Records.Add(new InFlightRecord { Id = Guid.Empty, Target = second, Root = second });
            InFlightReconciler.Apply(rows, tree.Node(siblings), batch, new HashSet<Guid> { orderId });
            Assert.Equal(3, rows.Count);
            var cache = TestTree.Cache((lineRoot, new List<Entity> { first }), (order, new List<Entity>()), (siblings, rows));
            const string mapping = "[{\"target\":\"sample_description\",\"source\":\"row\",\"column\":\"sample_name\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = type, TargetNodeId = siblings, IsActive = true,
                FieldMapping = type == ActionType.UpdateRecord ? mapping : null };
            var m = new FakeMetadata();

            var intents = new WriteIntentResolver(tree, m, m, Now).ResolveSet(action, type == ActionType.UpdateRecord ? Map(mapping) : new List<FieldMappingEntry>(),
                first, cache, RuleEvaluationContext.User);

            Assert.Equal(2, intents.Count); // the persisted line and the evaluated line; never the other in-flight line
            Assert.Single(intents, i => i.TargetId == persisted.Id);
            var own = Assert.Single(intents, i => i.TargetId == Guid.Empty);
            if (type == ActionType.UpdateRecord)
            {
                Assert.True(own.RootTargeted);
                Assert.Equal("First", own.Values["sample_description"]);
                var cs = ChangeSet.Build(intents, new RootRecord("sample_orderline", Guid.Empty));
                Assert.Equal("First", cs.RootInPlaceValues["sample_description"]);
            }
        }

        [Fact]
        public void A_create_with_a_stale_single_target_stays_one_plain_create()
        {
            const string mapping = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hi\"}]";
            var action = Action(ActionType.CreateRecord, OwnerId, mapping);

            Assert.False(SetActions.IsSetAction(action, Tree()));
            var intent = Resolver().Resolve(action, Map(mapping), Root(), TestTree.Cache((RootId, new List<Entity> { Root() })), RuleEvaluationContext.User);

            Assert.Equal(WriteOperation.Create, intent.Operation);
            Assert.NotEqual(Guid.Empty, intent.TargetId.Value);
            Assert.False(intent.AlwaysWrite);
        }

        [Fact]
        public void A_row_token_on_a_single_record_action_is_a_named_error()
        {
            const string mapping = "[{\"target\":\"description\",\"source\":\"template\",\"template\":\"{row.fullname}\"}]";
            var action = Action(ActionType.UpdateRecord, RootId, mapping);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Resolver().Resolve(action, Map(mapping), Root(),
                TestTree.Cache((RootId, new List<Entity> { Root() })), RuleEvaluationContext.User));
            Assert.Contains("can only be used by an action that writes a set of rows", ex.Message);
        }

        [Fact]
        public void A_row_source_on_a_single_record_action_is_a_named_error()
        {
            const string mapping = "[{\"target\":\"description\",\"source\":\"row\",\"column\":\"fullname\"}]";
            var action = Action(ActionType.UpdateRecord, RootId, mapping);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Resolver().Resolve(action, Map(mapping), Root(),
                TestTree.Cache((RootId, new List<Entity> { Root() })), RuleEvaluationContext.User));
            Assert.Contains("uses the current row", ex.Message);
        }
    }
}
