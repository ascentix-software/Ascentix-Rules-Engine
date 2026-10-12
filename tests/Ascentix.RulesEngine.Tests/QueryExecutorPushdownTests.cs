using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// QueryExecutor pushdown mechanics: variant fetches carry the pushed filter,
    /// results land under (nodeId, variantKey), the unfiltered fetch is skipped when the planner
    /// cleared DemandsUnfiltered, and the traversal cap counts rows RETURNED, failing with the
    /// named error, never truncating.
    /// </summary>
    public class QueryExecutorPushdownTests
    {
        private class FakeService : IOrganizationService
        {
            public List<string> Fetches = new List<string>();
            public Func<string, int, EntityCollection> OnFetch; // (fetchXml, callIndex) -> page

            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                var xml = ((FetchExpression)query).Query;
                Fetches.Add(xml);
                return OnFetch(xml, Fetches.Count - 1);
            }

            public Guid Create(Entity entity) => throw new NotSupportedException();
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }

        private static EntityCollection Page(string table, int count, bool more = false, string cookie = null)
        {
            var col = new EntityCollection { MoreRecords = more, PagingCookie = cookie };
            for (var i = 0; i < count; i++) col.Entities.Add(new Entity(table, Guid.NewGuid()));
            return col;
        }

        private static (TableConfigTree configs, QueryExecutionPlan plan, ExecutionPlanEntry entry, Entity root)
            ChildSetup()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = childId,
                    TableLogicalName = "contact",
                    ConfigType = TableConfigType.ChildTable,
                    ChildLinkField = "parentcustomerid",
                    ParentTableId = rootId,
                }
            );
            var entry = new ExecutionPlanEntry { Node = configs.Node(childId), ParentCacheKey = rootId.ToString() };
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { entry });
            return (configs, plan, entry, new Entity("account", Guid.NewGuid()));
        }

        [Fact]
        public void Variant_fetch_carries_pushed_filter_and_stores_under_variant_key()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.Variants.Add(new NodeQueryVariant
            {
                Key = "and(c[statuscode|eq|1])",
                FilterFetchXml = "<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
            });

            var svc = new FakeService
            {
                OnFetch = (xml, i) => Page("contact", xml.Contains("statuscode") ? 2 : 5),
            };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Equal(2, svc.Fetches.Count); // unfiltered + one variant
            Assert.DoesNotContain("statuscode", svc.Fetches[0]);
            Assert.Contains("<condition attribute='statuscode' operator='eq' value='1' />", svc.Fetches[1]);

            Assert.Equal(5, cache.Get(entry.Node.Id).Count);
            Assert.Equal(2, cache.Get(entry.Node.Id, "and(c[statuscode|eq|1])").Count);
        }

        [Fact]
        public void Unfiltered_fetch_is_skipped_when_not_demanded()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(new NodeQueryVariant { Key = "k", FilterFetchXml = "<filter type='and'><condition attribute='a' operator='eq' value='1' /></filter>" });

            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 3) };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            // The one fetch that ran was the variant; a 3M-row collection is never materialized.
            Assert.Single(svc.Fetches);
            Assert.Contains("attribute='a'", svc.Fetches[0]);
            Assert.False(cache.Has(entry.Node.Id));
            Assert.True(cache.Has(entry.Node.Id, "k"));
        }

        [Fact]
        public void Cap_counts_returned_rows_and_fails_with_named_error()
        {
            var (configs, plan, entry, root) = ChildSetup();
            var svc = new FakeService
            {
                // 5k pages forever: an unfiltered fetch of a huge collection.
                OnFetch = (xml, i) => Page("contact", 5000, more: true, cookie: "c"),
            };
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => new QueryExecutor(svc, new QueryResultCache(), configs).Execute(root, plan));

            Assert.Contains("25,000", ex.Message);
            Assert.Contains("contact", ex.Message);
            Assert.Contains("account", ex.Message);
            Assert.Contains(entry.Node.Id.ToString(), ex.Message);
            // Failed before fetching the whole collection: exactly cap/page + 1 pages.
            Assert.Equal(6, svc.Fetches.Count);
        }

        [Fact]
        public void Exactly_cap_rows_passes()
        {
            var (configs, plan, entry, root) = ChildSetup();
            var pages = 0;
            var svc = new FakeService
            {
                OnFetch = (xml, i) =>
                {
                    pages++;
                    return Page("contact", 5000, more: pages < 5, cookie: "c");
                },
            };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);
            Assert.Equal(QueryExecutor.MaxReturnedRowsPerVariant, cache.Get(entry.Node.Id).Count);
        }

        [Fact]
        public void Lookup_variant_fetch_carries_pushed_filter()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = lookupId,
                    TableLogicalName = "sample_customer",
                    ConfigType = TableConfigType.LookupTable,
                    LookupColumnLogicalName = "sample_customerid",
                    LookupTargetIdAttribute = "sample_customerid",
                    ParentTableId = rootId,
                }
            );
            var entry = new ExecutionPlanEntry { Node = configs.Node(lookupId), ParentCacheKey = rootId.ToString() };
            entry.Variants.Add(new NodeQueryVariant { Key = "k", FilterFetchXml = "<filter type='and'><condition attribute='sample_region' operator='eq' value='West' /></filter>" });
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { entry });

            var root = new Entity("sample_order", Guid.NewGuid());
            root["sample_customerid"] = new EntityReference("sample_customer", Guid.NewGuid());

            var svc = new FakeService { OnFetch = (xml, i) => Page("sample_customer", 1) };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Equal(2, svc.Fetches.Count);
            Assert.Contains("sample_region", svc.Fetches[1]);
            Assert.True(cache.Has(lookupId));
            Assert.True(cache.Has(lookupId, "k"));
        }

        [Fact]
        public void Empty_parent_set_stores_empty_variants_without_fetching()
        {
            var (configs, plan, entry, root) = ChildSetup();
            // Reparent the child to a node whose fetch ran and matched nothing. (A parent the
            // planner never fetched is a different fact: the executor's parent read throws for
            // it rather than scoping the child to an empty set; see QueryResultCacheTests.)
            var emptyParent = Guid.NewGuid();
            entry.ParentCacheKey = emptyParent.ToString();
            entry.Variants.Add(new NodeQueryVariant { Key = "k", FilterFetchXml = "<filter type='and' />" });

            var svc = new FakeService { OnFetch = (xml, i) => throw new Exception("must not fetch") };
            var cache = new QueryResultCache();
            cache.Store(emptyParent, new List<Entity>());
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Empty(svc.Fetches);
            Assert.True(cache.Has(entry.Node.Id));
            Assert.True(cache.Has(entry.Node.Id, "k"));
            Assert.Empty(cache.Get(entry.Node.Id, "k"));
        }

        // ── anchored date placeholders ──────────────────────────────────────────────────────

        private static NodeQueryVariant BoundVariant(Guid anchorNodeId, string op, int days,
            DateColumnKind? kind = null, TimeZoneInfo zone = null)
        {
            var payload = "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + anchorNodeId + "\",\"column\":\"createdon\"},"
                        + "\"op\":\"add\",\"amount\":" + days + ",\"unit\":\"days\"}";
            var filter = new PushedFilter();
            filter.Conditions.Add(new PushedCondition { Attribute = "createdon", Operator = op, Binding = new DateBinding(payload, op, kind, zone) });
            return new NodeQueryVariant { Key = filter.CanonicalKey(), Filter = filter };
        }

        [Fact]
        public void Bound_variant_carries_the_roots_own_date_widened()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(BoundVariant(entry.Node.ParentTableId.Value, "gt", 30));
            root["createdon"] = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 0) };

            new QueryExecutor(svc, new QueryResultCache(configs), configs).Execute(root, plan);

            // 2026-09-01 + 30 days = 2026-10-01, widened one day earlier for gt.
            Assert.Contains("<condition attribute='createdon' operator='gt' value='2026-09-30T00:00:00Z' />", Assert.Single(svc.Fetches));
        }

        [Fact]
        public void Bound_variant_with_a_known_behavior_carries_the_exact_value()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(BoundVariant(entry.Node.ParentTableId.Value, "eq", 30,
                DateColumnKind.CalendarDate, TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time")));
            root["createdon"] = new DateTime(2026, 9, 1, 2, 0, 0, DateTimeKind.Utc);
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 0) };

            new QueryExecutor(svc, new QueryResultCache(configs), configs).Execute(root, plan);

            // 2026-10-01T02:00Z is 22:00 EDT on Sep 30: the Date Only value is that calendar day,
            // pushed as a half-open range.
            Assert.Contains("<condition attribute='createdon' operator='ge' value='2026-09-30' />" +
                "<condition attribute='createdon' operator='lt' value='2026-10-01' />", Assert.Single(svc.Fetches));
        }

        [Fact]
        public void Each_root_binds_its_own_date()
        {
            var (configs, plan, entry, _) = ChildSetup();
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(BoundVariant(entry.Node.ParentTableId.Value, "gt", 30));
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 0) };

            foreach (var created in new[] { new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc), new DateTime(2026, 3, 1, 0, 0, 0, DateTimeKind.Utc) })
                new QueryExecutor(svc, new QueryResultCache(configs), configs)
                    .Execute(new Entity("account", Guid.NewGuid()) { ["createdon"] = created }, plan);

            Assert.Contains("value='2026-09-30T00:00:00Z'", svc.Fetches[0]);
            Assert.Contains("value='2026-03-30T00:00:00Z'", svc.Fetches[1]);
        }

        [Fact]
        public void Unbindable_variant_fetches_without_its_pushed_filter()
        {
            var (configs, plan, entry, root) = ChildSetup();       // root has no createdon
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(BoundVariant(entry.Node.ParentTableId.Value, "gt", 30));
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 2) };
            var cache = new QueryResultCache(configs);

            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.DoesNotContain("operator='gt'", Assert.Single(svc.Fetches));
            Assert.Equal(2, cache.Get(entry.Node.Id, entry.Variants[0].Key).Count); // memory filters these rows
        }

        [Fact]
        public void Created_on_of_a_root_being_created_binds_to_the_evaluation_instant()
        {
            var now = new DateTime(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc);
            var (configs, plan, entry, root) = ChildSetup();       // a Create's Target: no createdon
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(BoundVariant(entry.Node.ParentTableId.Value, "gt", 30));
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 0) };

            new QueryExecutor(svc, new QueryResultCache(configs), configs, utcNow: now, rootIsNew: true).Execute(root, plan);

            // now + 30 days = 2026-10-27T12:00Z, widened one day earlier for gt.
            Assert.Contains("value='2026-10-26T12:00:00Z'", Assert.Single(svc.Fetches));
        }

        private static string CreatedOnPlus(Guid anchorNodeId, int days) =>
            "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + anchorNodeId + "\",\"column\":\"createdon\"},"
            + "\"op\":\"add\",\"amount\":" + days + ",\"unit\":\"days\"}";

        // statuscode eq 1 AND (createdon gt <anchor + 30d> OR statecode eq 0), translated the way
        // the planner does, so the variant carries a placeholder inside an OR child group.
        private static NodeQueryVariant OrPlaceholderVariant(Guid anchorNodeId)
        {
            var group = new NodeFilterGroup
            {
                LogicalOperator = Ascentix.RulesEngine.Core.Models.LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { Kind = CriterionKind.Comparison, FieldName = "statuscode", Operator = "eq", Value = "1" } },
                ChildGroups =
                {
                    new NodeFilterGroup
                    {
                        LogicalOperator = Ascentix.RulesEngine.Core.Models.LogicalOperator.Or,
                        Criteria =
                        {
                            new NodeFilterCriterion { Kind = CriterionKind.Comparison, FieldName = "createdon", Operator = "gt",
                                ValueSource = ComparisonValueSource.DateExpression, Value = CreatedOnPlus(anchorNodeId, 30) },
                            new NodeFilterCriterion { Kind = CriterionKind.Comparison, FieldName = "statecode", Operator = "eq", Value = "0" },
                        },
                    },
                },
            };
            var pushed = new PushdownTranslator(canBindAnchor: id => id == anchorNodeId).Translate(group);
            Assert.False(pushed.HasResidual);
            return new NodeQueryVariant { Key = pushed.Pushed.CanonicalKey(), Filter = pushed.Pushed };
        }

        [Fact]
        public void Placeholder_in_an_or_group_binds_through_the_executor()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(OrPlaceholderVariant(entry.Node.ParentTableId.Value));
            root["createdon"] = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 0) };

            new QueryExecutor(svc, new QueryResultCache(configs), configs).Execute(root, plan);

            var fetch = Assert.Single(svc.Fetches);
            Assert.Contains("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' />" +
                "<filter type='or'><condition attribute='createdon' operator='gt' value='2026-09-30T00:00:00Z' />" +
                "<condition attribute='statecode' operator='eq' value='0' /></filter></filter>", fetch);
        }

        [Fact]
        public void Unbindable_placeholder_in_an_or_group_drops_only_that_group()
        {
            var (configs, plan, entry, root) = ChildSetup();       // root has no createdon
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(OrPlaceholderVariant(entry.Node.ParentTableId.Value));
            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 2) };
            var cache = new QueryResultCache(configs);

            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            // The OR has no bound for this root, so it relaxes to "no constraint"; the sibling
            // conjunct still narrows the fetch. Memory re-applies the full filter to these rows.
            var fetch = Assert.Single(svc.Fetches);
            Assert.Contains("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>", fetch);
            Assert.DoesNotContain("statecode", fetch);
            Assert.DoesNotContain("createdon", fetch);
            Assert.Equal(2, cache.Get(entry.Node.Id, entry.Variants[0].Key).Count);
        }

        [Fact]
        public void Lookup_anchor_deeper_than_the_filtered_child_binds_from_the_loaded_record()
        {
            // account -> contact (lookup, level 1) -> systemuser (lookup, level 2); task is a child
            // of account (level 1) filtered on the systemuser's createdon. The anchor loads a level
            // AFTER the filtered node, which only the two-phase order (every unfiltered fetch first)
            // makes available when the task variant binds.
            var rootId = Guid.NewGuid();
            var contactId = Guid.NewGuid();
            var userId = Guid.NewGuid();
            var taskId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = contactId, TableLogicalName = "contact", ConfigType = TableConfigType.LookupTable,
                    LookupColumnLogicalName = "primarycontactid", LookupTargetIdAttribute = "contactid", ParentTableId = rootId },
                new TableConfig { Id = userId, TableLogicalName = "systemuser", ConfigType = TableConfigType.LookupTable,
                    LookupColumnLogicalName = "owninguser", LookupTargetIdAttribute = "systemuserid", ParentTableId = contactId },
                new TableConfig { Id = taskId, TableLogicalName = "task", ConfigType = TableConfigType.ChildTable,
                    ChildLinkField = "regardingobjectid", ParentTableId = rootId });
            var contactEntry = new ExecutionPlanEntry { Node = configs.Node(contactId), ParentCacheKey = rootId.ToString() };
            var userEntry = new ExecutionPlanEntry { Node = configs.Node(userId), ParentCacheKey = contactId.ToString() };
            var taskEntry = new ExecutionPlanEntry { Node = configs.Node(taskId), ParentCacheKey = rootId.ToString(), DemandsUnfiltered = false };
            taskEntry.Variants.Add(BoundVariant(userId, "lt", 10));
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { taskEntry, contactEntry });
            plan.Levels.Add(new List<ExecutionPlanEntry> { userEntry });

            var contact = new Entity("contact", Guid.NewGuid()) { ["owninguser"] = new EntityReference("systemuser", Guid.NewGuid()) };
            var user = new Entity("systemuser", Guid.NewGuid()) { ["createdon"] = new DateTime(2026, 5, 10, 8, 0, 0, DateTimeKind.Utc) };
            var root = new Entity("account", Guid.NewGuid()) { ["primarycontactid"] = new EntityReference("contact", contact.Id) };
            var svc = new FakeService
            {
                OnFetch = (xml, i) =>
                {
                    var page = new EntityCollection();
                    if (xml.Contains("'contact'")) page.Entities.Add(contact);
                    else if (xml.Contains("'systemuser'")) page.Entities.Add(user);
                    return page;
                },
            };

            new QueryExecutor(svc, new QueryResultCache(configs), configs).Execute(root, plan);

            // 2026-05-10T08:00Z + 10 days = 2026-05-20T08:00Z, widened one day later for lt.
            Assert.Equal(3, svc.Fetches.Count);
            Assert.Contains("'task'", svc.Fetches[2]);
            Assert.Contains("<condition attribute='createdon' operator='lt' value='2026-05-21T08:00:00Z' />", svc.Fetches[2]);
        }

        [Fact]
        public void Every_unfiltered_fetch_runs_before_any_variant()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var grandId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childId, TableLogicalName = "contact", ConfigType = TableConfigType.ChildTable, ChildLinkField = "parentcustomerid", ParentTableId = rootId },
                new TableConfig { Id = grandId, TableLogicalName = "task", ConfigType = TableConfigType.ChildTable, ChildLinkField = "regardingobjectid", ParentTableId = childId });
            var child = new ExecutionPlanEntry { Node = configs.Node(childId), ParentCacheKey = rootId.ToString() };
            child.Variants.Add(new NodeQueryVariant
            {
                Key = "and(c[statuscode|eq|1])",
                FilterFetchXml = "<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
            });
            var grand = new ExecutionPlanEntry { Node = configs.Node(grandId), ParentCacheKey = childId.ToString() };
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { child });
            plan.Levels.Add(new List<ExecutionPlanEntry> { grand });
            var svc = new FakeService { OnFetch = (xml, i) => xml.Contains("'contact'") ? Page("contact", 1) : Page("task", 0) };

            new QueryExecutor(svc, new QueryResultCache(configs), configs).Execute(new Entity("account", Guid.NewGuid()), plan);

            Assert.Equal(3, svc.Fetches.Count);
            Assert.DoesNotContain("statuscode", svc.Fetches[0]);   // contact, unfiltered
            Assert.Contains("'task'", svc.Fetches[1]);               // task, unfiltered
            Assert.Contains("statuscode", svc.Fetches[2]);         // contact variant, last
        }
    }
}
