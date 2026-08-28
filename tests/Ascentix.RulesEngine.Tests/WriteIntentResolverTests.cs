using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class WriteIntentResolverTests
    {
        private sealed class FakeMetadata : IAttributeMetadataProvider, IOptionLabelProvider
        {
            public AttributeTypeCode? GetAttributeType(string table, string column)
            {
                switch (column)
                {
                    case "statuscode": return AttributeTypeCode.Picklist;
                    case "followupby": return AttributeTypeCode.DateTime;
                    case "createdon": return AttributeTypeCode.DateTime;
                    case "objectid": return AttributeTypeCode.Lookup;
                    case "qtyint": return AttributeTypeCode.Integer;
                    case "amount": return AttributeTypeCode.Money;
                    default: return AttributeTypeCode.String;
                }
            }

            public string GetOptionLabel(string table, string column, int value) =>
                column == "statuscode" && value == 1 ? "Open" : null;
        }

        private static readonly DateTime Now = new DateTime(2026, 7, 5, 12, 0, 0, DateTimeKind.Utc);

        private static readonly Guid RootId = Guid.NewGuid();

        private static TableConfig Lookup(Guid id, string table) =>
            TestTree.Node(id, table, TableConfigType.LookupTable, RootId);

        private static TableConfig Child(Guid id, string table) =>
            TestTree.Node(id, table, TableConfigType.ChildTable, RootId);

        /// <summary>root account plus the given related nodes (parented at the root).</summary>
        private static (WriteIntentResolver resolver, Guid rootId, QueryResultCache cache) Setup(params TableConfig[] related)
        {
            var nodes = new List<TableConfig> { TestTree.Node(RootId, "account", TableConfigType.RootTable, null) };
            nodes.AddRange(related);
            var cache = new QueryResultCache();
            var meta = new FakeMetadata();
            var resolver = new WriteIntentResolver(TestTree.Tree(nodes.ToArray()), meta, meta, Now);
            return (resolver, RootId, cache);
        }

        [Fact]
        public void Create_resolves_table_and_coerced_values()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId) { ["name"] = "Acme" };
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "literal", Value = "Hi" },
                new FieldMappingEntry { Target = "statuscode", Source = "literal", Value = 2 },
                new FieldMappingEntry { Target = "subject2", Source = "root", Column = "name" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);

            Assert.Equal(WriteOperation.Create, intent.Operation);
            Assert.Equal("task", intent.TargetTable);
            Assert.Null(intent.TargetId);
            Assert.Equal("Hi", intent.Values["subject"]);
            Assert.Equal(2, ((OptionSetValue)intent.Values["statuscode"]).Value);
            Assert.Equal("Acme", intent.Values["subject2"]); // copied raw from root
            Assert.False(intent.RootTargeted);
        }

        [Fact]
        public void Update_targeting_root_is_root_targeted()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.UpdateRecord, TargetNodeId = rootId };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "literal", Value = "X" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);

            Assert.Equal(WriteOperation.Update, intent.Operation);
            Assert.True(intent.RootTargeted);
            Assert.Equal(rootId, intent.TargetId);
            Assert.Equal("account", intent.TargetTable);
        }

        [Fact]
        public void Delete_targeting_node_resolves_single_record()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));
            var root = new Entity("account", rootId);
            var related = new Entity("contact", Guid.NewGuid());
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity> { related });

            var action = new RuleAction { ActionType = ActionType.DeleteRecord, TargetNodeId = lookupId };

            var intent = resolver.Resolve(action, new List<FieldMappingEntry>(), root, cache, RuleEvaluationContext.System);

            Assert.Equal(WriteOperation.Delete, intent.Operation);
            Assert.Equal("contact", intent.TargetTable);
            Assert.Equal(related.Id, intent.TargetId);
            Assert.Equal(RuleEvaluationContext.System, intent.Context);
        }

        [Fact]
        public void Update_target_node_with_no_record_is_noop_null()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));
            cache.Store(rootId, new List<Entity> { new Entity("account", rootId) });
            cache.Store(lookupId, new List<Entity>()); // none resolved

            var action = new RuleAction { ActionType = ActionType.UpdateRecord, TargetNodeId = lookupId };
            var intent = resolver.Resolve(action, new List<FieldMappingEntry>(), new Entity("account", rootId),
                cache, RuleEvaluationContext.User);

            Assert.Null(intent);
        }

        [Fact]
        public void Child_target_node_throws()
        {
            var childId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Child(childId, "task"));
            cache.Store(rootId, new List<Entity> { new Entity("account", rootId) });

            var action = new RuleAction { ActionType = ActionType.DeleteRecord, TargetNodeId = childId };

            Assert.Throws<InvalidPluginExecutionException>(() =>
                resolver.Resolve(action, new List<FieldMappingEntry>(), new Entity("account", rootId),
                    cache, RuleEvaluationContext.User));
        }

        [Fact]
        public void Create_with_node_source_copies_raw_value_from_lookup_node()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));

            var root = new Entity("account", rootId) { ["name"] = "Acme" };
            var relatedContact = new Entity("contact", Guid.NewGuid()) { ["lastname"] = "Smith" };
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity> { relatedContact });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "node", Node = lookupId, Column = "lastname" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);

            Assert.Equal(WriteOperation.Create, intent.Operation);
            Assert.Equal("task", intent.TargetTable);
            Assert.Equal("Smith", intent.Values["subject"]); // raw value from node
        }

        [Fact]
        public void Update_with_node_source_copies_raw_value_from_lookup_node()
        {
            var lookupId = Guid.NewGuid();
            var taskNodeId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"), Lookup(taskNodeId, "task"));

            var root = new Entity("account", rootId);
            var relatedContact = new Entity("contact", Guid.NewGuid()) { ["lastname"] = "Jones" };
            var targetRecord = new Entity("task", Guid.NewGuid());

            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity> { relatedContact });
            cache.Store(taskNodeId, new List<Entity> { targetRecord });

            var action = new RuleAction { ActionType = ActionType.UpdateRecord, TargetNodeId = taskNodeId };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "node", Node = lookupId, Column = "lastname" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);

            Assert.Equal(WriteOperation.Update, intent.Operation);
            Assert.Equal("task", intent.TargetTable);
            Assert.Equal(targetRecord.Id, intent.TargetId);
            Assert.Equal("Jones", intent.Values["subject"]); // raw value from related node
        }

        [Fact]
        public void Create_with_node_source_pointing_to_child_throws()
        {
            var childId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Child(childId, "task"));
            cache.Store(rootId, new List<Entity> { new Entity("account", rootId) });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "node", Node = childId, Column = "subject" },
            };

            Assert.Throws<InvalidPluginExecutionException>(() =>
                resolver.Resolve(action, mapping, new Entity("account", rootId), cache, RuleEvaluationContext.User));
        }

        [Fact]
        public void Create_with_node_source_resolving_zero_records_yields_null()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));

            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity>()); // no records resolved

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "node", Node = lookupId, Column = "lastname" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);

            Assert.Equal(WriteOperation.Create, intent.Operation);
            Assert.Null(intent.Values["subject"]); // null when no records resolved
        }

        [Fact]
        public void Ref_to_root_writes_entity_reference_to_root()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "annotation" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "objectid", Source = "ref", Node = rootId },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            var er = Assert.IsType<EntityReference>(intent.Values["objectid"]);
            Assert.Equal("account", er.LogicalName);
            Assert.Equal(rootId, er.Id);
        }

        [Fact]
        public void Ref_to_single_node_writes_entity_reference_to_that_record()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));
            var root = new Entity("account", rootId);
            var contact = new Entity("contact", Guid.NewGuid());
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity> { contact });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "annotation" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "objectid", Source = "ref", Node = lookupId },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            var er = Assert.IsType<EntityReference>(intent.Values["objectid"]);
            Assert.Equal("contact", er.LogicalName);
            Assert.Equal(contact.Id, er.Id);
        }

        [Fact]
        public void Ref_to_node_resolving_zero_records_yields_null()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));
            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity>());

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "annotation" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "objectid", Source = "ref", Node = lookupId },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.Null(intent.Values["objectid"]);
        }

        [Fact]
        public void Ref_on_non_lookup_target_throws()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "annotation" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "ref", Node = rootId }, // subject => String
            };

            Assert.Throws<InvalidPluginExecutionException>(() =>
                resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User));
        }

        [Fact]
        public void Template_source_renders_against_root_and_node()
        {
            var lookupId = Guid.NewGuid();
            var (resolver, rootId, cache) = Setup(Lookup(lookupId, "contact"));
            var root = new Entity("account", rootId) { ["name"] = "Acme", ["statuscode"] = new OptionSetValue(1) };
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(lookupId, new List<Entity> { new Entity("contact", Guid.NewGuid()) { ["fullname"] = "Sam Roe" } });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "subject", Source = "template",
                    Template = $"Follow up: {{root.name}} ({{root.statuscode}}) — {{node:{lookupId}.fullname}}" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.Equal("Follow up: Acme (Open) — Sam Roe", intent.Values["subject"]);
        }

        [Fact]
        public void Template_on_non_string_target_throws()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "followupby", Source = "template", Template = "x" },
            };

            Assert.Throws<InvalidPluginExecutionException>(() =>
                resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User));
        }

        [Fact]
        public void Dateexpr_now_anchor_adds_interval_to_injected_clock()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "followupby", Source = "dateexpr",
                    AnchorKind = "now", Op = "add", Amount = 3, Unit = "days" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.Equal(Now.AddDays(3), intent.Values["followupby"]);
        }

        [Fact]
        public void Dateexpr_field_anchor_reads_root_column()
        {
            var (resolver, rootId, cache) = Setup();
            var created = new DateTime(2026, 1, 31, 8, 0, 0, DateTimeKind.Utc);
            var root = new Entity("account", rootId) { ["createdon"] = created };
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "followupby", Source = "dateexpr",
                    AnchorKind = "field", AnchorColumn = "createdon", Op = "add", Amount = 1, Unit = "months" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.Equal(created.AddMonths(1), intent.Values["followupby"]); // Feb 28 clamp
        }

        [Fact]
        public void Dateexpr_null_anchor_field_skips_the_column()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId); // no createdon
            cache.Store(rootId, new List<Entity> { root });

            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "followupby", Source = "dateexpr",
                    AnchorKind = "field", AnchorColumn = "createdon", Op = "add", Amount = 3, Unit = "days" },
                new FieldMappingEntry { Target = "subject", Source = "literal", Value = "kept" },
            };

            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.False(intent.Values.ContainsKey("followupby")); // skipped, not null-written
            Assert.Equal("kept", intent.Values["subject"]);
        }

        [Fact]
        public void Mathexpr_rounds_into_integer_target()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "qtyint", Source = "mathexpr", Expression = "7 / 2" }, // 3.5 -> 4
            };
            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.Equal(4, intent.Values["qtyint"]);
        }

        [Fact]
        public void Mathexpr_writes_money_target()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "amount", Source = "mathexpr", Expression = "2 * 2.5" },
            };
            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.Equal(5m, ((Money)intent.Values["amount"]).Value);
        }

        [Fact]
        public void Mathexpr_null_operand_writes_nothing()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId); // no "missing" column
            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "amount", Source = "mathexpr", Expression = "{root.missing} * 2" },
            };
            var intent = resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User);
            Assert.False(intent.Values.ContainsKey("amount"));
        }

        [Fact]
        public void Mathexpr_non_numeric_target_throws()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId);
            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };
            var mapping = new List<FieldMappingEntry>
            {
                new FieldMappingEntry { Target = "name", Source = "mathexpr", Expression = "1 + 1" }, // name -> String
            };
            Assert.Throws<InvalidPluginExecutionException>(() =>
                resolver.Resolve(action, mapping, root, cache, RuleEvaluationContext.User));
        }

        [Fact]
        public void Dateexpr_on_non_date_target_and_non_date_anchor_throw()
        {
            var (resolver, rootId, cache) = Setup();
            var root = new Entity("account", rootId) { ["name"] = "not a date" };
            cache.Store(rootId, new List<Entity> { root });
            var action = new RuleAction { ActionType = ActionType.CreateRecord, TargetTable = "task" };

            Assert.Throws<InvalidPluginExecutionException>(() => resolver.Resolve(action,
                new List<FieldMappingEntry> { new FieldMappingEntry { Target = "subject", Source = "dateexpr",
                    AnchorKind = "now", Op = "add", Amount = 1, Unit = "days" } },
                root, cache, RuleEvaluationContext.User));

            Assert.Throws<InvalidPluginExecutionException>(() => resolver.Resolve(action,
                new List<FieldMappingEntry> { new FieldMappingEntry { Target = "followupby", Source = "dateexpr",
                    AnchorKind = "field", AnchorColumn = "name", Op = "add", Amount = 1, Unit = "days" } },
                root, cache, RuleEvaluationContext.User));
        }
    }
}
