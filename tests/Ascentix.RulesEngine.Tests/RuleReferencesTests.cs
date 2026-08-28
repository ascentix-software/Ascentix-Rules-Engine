using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// The rule reference set: one computation of what a rule touches, read through its named
    /// answers (nodesToLoad / optional / nodesToPlan / hardReaders / filterDerivedNodes /
    /// unpruneable / rootColumns / isRootOnly / referencesByKind).
    /// </summary>
    public class RuleReferencesTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LookupId = Guid.NewGuid();
        private static readonly Guid ChildId = Guid.NewGuid();
        private static readonly Guid SiblingId = Guid.NewGuid();

        private static TableConfigTree Tree() => TestTree.Tree(
            new TableConfig { Id = RootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
            new TableConfig { Id = LookupId, TableLogicalName = "contact", ConfigType = TableConfigType.LookupTable, ParentTableId = RootId, LookupColumnLogicalName = "primarycontactid" },
            new TableConfig { Id = ChildId, TableLogicalName = "task", ConfigType = TableConfigType.ChildTable, ParentTableId = RootId, ChildLinkField = "regardingobjectid" },
            new TableConfig { Id = SiblingId, TableLogicalName = "sample_shipment", ConfigType = TableConfigType.ChildTable, ParentTableId = RootId, ChildLinkField = "sample_orderid" });

        private static RuleCondition RootCond(string column = "name") => new RuleCondition
        { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = column, ComparisonOperator = ComparisonOperator.IsNotNull };

        private static ConditionGroup Group(params RuleCondition[] conditions) => new ConditionGroup
        { Id = Guid.NewGuid(), Conditions = conditions.ToList() };

        private static List<ConditionGroup> Groups(params ConditionGroup[] groups) => groups.ToList();

        private static RuleAction Active(ActionType type) => new RuleAction
        { Id = Guid.NewGuid(), ActionType = type, FireOn = ActionFireOn.OnMatch, IsActive = true };

        private static RuleReferences Refs(ConditionGroup group, params RuleAction[] actions) =>
            RuleReferences.Compute(Groups(group), actions);

        // ─── Root columns (moved from RootColumnCollectorTests) ─────────────

        [Fact]
        public void Collects_root_comparison_lookup_and_filter_columns_only()
        {
            var rootId = Guid.NewGuid();
            var lookupChildId = Guid.NewGuid();
            var unrelatedNodeId = Guid.NewGuid();

            var tree = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = lookupChildId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId, LookupColumnLogicalName = "primarycontactid" },
                new TableConfig { Id = unrelatedNodeId, ConfigType = TableConfigType.LookupTable, ParentTableId = lookupChildId, LookupColumnLogicalName = "parentcustomerid" }); // NOT a child of root

            var rootGroup = new ConditionGroup
            {
                Conditions =
                {
                    new RuleCondition { TableConfigNodeId = rootId, ComparisonColumn = "name" },
                    new RuleCondition { TableConfigNodeId = unrelatedNodeId, ComparisonColumn = "ignore_me" },
                },
                NodeFilterGroups =
                {
                    new NodeFilterGroup { TableConfigNodeId = rootId, Criteria = { new NodeFilterCriterion { FieldName = "statecode" } } }
                }
            };

            var cols = RuleReferences.Compute(Groups(rootGroup), null).RootColumns(tree);

            Assert.Contains("name", cols);
            Assert.Contains("primarycontactid", cols);
            Assert.Contains("statecode", cols);
            Assert.DoesNotContain("ignore_me", cols);      // condition on a non-root node
            Assert.DoesNotContain("parentcustomerid", cols); // lookup not parented by root
            Assert.Equal(3, cols.Count);
        }

        [Fact]
        public void Collects_template_and_dateexpression_root_columns()
        {
            var rootGroup = Group(
                // Template RHS referencing a root-scoped token, resolved against the
                // triggering root record regardless of which node the condition itself is on.
                new RuleCondition
                {
                    Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name",
                    ValueSource = ComparisonValueSource.Template, ComparisonValue = "Hello {root.foo}!",
                },
                // DateExpression RHS with a field anchor on the root (AnchorNode == null).
                new RuleCondition
                {
                    Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name",
                    ValueSource = ComparisonValueSource.DateExpression,
                    ComparisonValue = "{\"anchor\":{\"kind\":\"field\",\"column\":\"bar\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
                });

            var cols = Refs(rootGroup).RootColumns(Tree());

            Assert.Contains("foo", cols);
            Assert.Contains("bar", cols);
        }

        [Fact]
        public void Collects_expression_condition_root_operand()
        {
            // {root.taxrate} has no node (same-record on root), so its column belongs in the root ColumnSet.
            var rootGroup = Group(new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression,
                Expression = "{root.taxrate}", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "0",
            });

            Assert.Contains("taxrate", Refs(rootGroup).RootColumns(Tree()));
        }

        [Fact]
        public void Collects_expression_condition_root_operand_when_rhs_is_field_reference()
        {
            // The Expression LHS-operand collection must run regardless of the RHS ValueSource.
            var rootGroup = Group(new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression,
                Expression = "{root.taxrate}", ComparisonOperator = ComparisonOperator.GreaterThan,
                ValueSource = ComparisonValueSource.FieldReference, ComparisonValueColumn = "threshold",
            });

            var cols = Refs(rootGroup).RootColumns(Tree());

            Assert.Contains("taxrate", cols);   // Expression LHS root operand
            Assert.Contains("threshold", cols); // FieldReference RHS root column
        }

        [Fact]
        public void IsRootOnly_false_when_expression_condition_references_child_node()
        {
            var rootGroup = Group(new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression,
                Expression = $"sum(node:{ChildId}.amt)", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "100",
            });

            Assert.False(Refs(rootGroup).IsRootOnly(Tree()));
        }

        // ─── Field-reference root columns (moved from RootColumnCollectorFieldRefTests) ──

        [Fact]
        public void RootColumns_includes_a_same_record_field_ref_column_on_the_root()
        {
            var group = Group(new RuleCondition
            {
                TableConfigNodeId = RootId, ComparisonColumn = "actualend",
                ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = null, ComparisonValueColumn = "actualstart",
            });

            var cols = Refs(group).RootColumns(Tree());

            Assert.Contains("actualend", cols);    // LHS column
            Assert.Contains("actualstart", cols);  // RHS field-ref column on the root
        }

        [Fact]
        public void RootColumns_includes_a_root_node_field_ref_column()
        {
            // LHS on the child; RHS references a column on the root.
            var group = Group(new RuleCondition
            {
                TableConfigNodeId = ChildId, ComparisonColumn = "price",
                ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = RootId, ComparisonValueColumn = "maxprice",
            });

            var cols = Refs(group).RootColumns(Tree());

            Assert.Contains("maxprice", cols);     // root RHS column collected
            Assert.DoesNotContain("price", cols);  // LHS is on the child, not the root
        }

        [Fact]
        public void IsRootOnly_false_when_a_field_ref_targets_a_lookup_node()
        {
            var group = Group(new RuleCondition
            {
                TableConfigNodeId = RootId, ComparisonColumn = "ownerid",
                ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = LookupId, ComparisonValueColumn = "ownerid",
            });

            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        // ─── Root-only verdict (moved from RootOnlyTests) ───────────────────

        [Fact]
        public void IsRootOnly_true_when_all_conditions_reference_root()
        {
            Assert.True(Refs(Group(RootCond())).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_any_condition_references_a_non_root_node()
        {
            var group = Group(RootCond(), new RuleCondition { TableConfigNodeId = LookupId, ComparisonColumn = "revenue" });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_is_false_when_the_tree_has_no_root()
        {
            // Fail closed: "root-only" is a proof that the rule's outcome is a pure function
            // of root columns, and a tree with no root cannot carry that proof.
            var orphanId = Guid.NewGuid();
            var group = Group(new RuleCondition { TableConfigNodeId = orphanId, ComparisonColumn = "name" });

            Assert.False(Refs(group).IsRootOnly(TableConfigTree.Empty));
            Assert.False(Refs(group).IsRootOnly(
                TestTree.RawTree(TestTree.Node(orphanId, "contact", TableConfigType.LookupTable, null))));
        }

        [Fact]
        public void IsRootOnly_is_false_for_a_condition_with_no_node()
        {
            var group = Group(new RuleCondition { TableConfigNodeId = Guid.Empty, ComparisonColumn = "name" });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        // ─── Mapping root sources (moved from ActionColumnCollectorTests) ───

        [Fact]
        public void Collects_only_root_source_columns_from_create_and_update_mappings()
        {
            var create = Active(ActionType.CreateRecord);
            create.FieldMapping = "create-json";
            var update = Active(ActionType.UpdateRecord);
            update.FieldMapping = "update-json";
            var visible = Active(ActionType.SetVisible); // ignored (not a write/mapping)

            List<Ascentix.RulesEngine.Core.Actions.FieldMappingEntry> Parse(RuleAction a) => a.FieldMapping == "create-json"
                ? new List<Ascentix.RulesEngine.Core.Actions.FieldMappingEntry>
                  {
                      new Ascentix.RulesEngine.Core.Actions.FieldMappingEntry { Target = "a", Source = "root", Column = "name" },
                      new Ascentix.RulesEngine.Core.Actions.FieldMappingEntry { Target = "b", Source = "literal", Value = 1 },
                  }
                : new List<Ascentix.RulesEngine.Core.Actions.FieldMappingEntry>
                  {
                      new Ascentix.RulesEngine.Core.Actions.FieldMappingEntry { Target = "c", Source = "root", Column = "revenue" },
                      new Ascentix.RulesEngine.Core.Actions.FieldMappingEntry { Target = "d", Source = "node", Column = "x", Node = LookupId },
                  };

            var cols = RuleReferences.Compute(null, new[] { create, update, visible }, Parse).RootColumns(Tree());

            Assert.Contains("name", cols);
            Assert.Contains("revenue", cols);
            Assert.DoesNotContain("x", cols);   // node source, not a root column
            Assert.Equal(3, cols.Count);        // + the root's lookup column primarycontactid
            Assert.Contains("primarycontactid", cols);
        }

        [Fact]
        public void Collects_template_root_tokens_and_root_dateexpr_anchors_from_mappings()
        {
            var create = Active(ActionType.CreateRecord);
            create.FieldMapping =
                "[{\"target\":\"subject\",\"source\":\"template\",\"template\":\"Hi {root.name} {root.city}\"}," +
                "{\"target\":\"followupby\",\"source\":\"dateexpr\"," +
                "\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"createdon\"}," +
                "\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}]";

            var cols = RuleReferences.Compute(null, new[] { create }).RootColumns(Tree());

            Assert.Contains("name", cols);
            Assert.Contains("city", cols);
            Assert.Contains("createdon", cols);
        }

        // ─── Config-load seed (moved from RuleValidationLoaderTests) ────────

        [Fact]
        public void NodesToLoad_includes_an_action_target_node_not_referenced_by_any_condition()
        {
            var update = Active(ActionType.UpdateRecord);
            update.TargetNodeId = LookupId;

            var refs = Refs(Group(RootCond()), update);

            Assert.Contains(LookupId, refs.NodesToLoad);
            Assert.Contains(LookupId, refs.NodeIds(ReferenceKind.ActionTargetNodes));
            Assert.Contains(LookupId, refs.HardReaders);
        }

        [Fact]
        public void NodesToLoad_includes_an_exists_collection_node_not_referenced_elsewhere()
        {
            // A node-filter EXISTS criterion's CollectionNodeId is a SIBLING collection no
            // condition/action references. It must still load, or the validator reports a false
            // TRAV_NODE_NOT_FOUND and the runtime plans a node it never fetched.
            var cond = new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = ChildId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };
            var group = Group(cond);
            var valueNode = Guid.NewGuid();
            group.NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = ChildId, RuleConditionId = cond.Id, LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists, CollectionNodeId = SiblingId, MinCount = 1,
                        SubFilter = new NodeFilterGroup
                        {
                            Criteria =
                            {
                                new NodeFilterCriterion { FieldName = "sample_shipamount", Operator = "gt", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = valueNode, ComparisonValueColumn = "threshold" },
                            },
                        },
                    },
                },
            });

            var refs = Refs(group);

            Assert.Contains(SiblingId, refs.NodesToLoad);
            Assert.Contains(valueNode, refs.NodesToLoad);
            Assert.Contains(SiblingId, refs.NodeIds(ReferenceKind.ExistsCollections));
            Assert.Contains(valueNode, refs.NodeIds(ReferenceKind.SubFilterNodes));
            Assert.Contains(SiblingId, refs.FilterDerivedNodes);
            Assert.Contains(valueNode, refs.FilterDerivedNodes);
        }

        // ─── Unpruneable (moved from TraversalColumnCollectorTests) ─────────

        [Fact]
        public void Unpruneable_nodes_are_left_at_full_width()
        {
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = ChildId, ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = "subject", ComparisonOperator = ComparisonOperator.Equals, ComparisonValue = "1",
            };
            var create = Active(ActionType.CreateRecord);
            create.FieldMapping = $"[{{\"target\":\"t\",\"source\":\"mathexpr\",\"expression\":\"sum(node:{ChildId}.amt)\"}}]";
            var groups = Groups(Group(cond));

            var refs = RuleReferences.Compute(groups, new[] { create });
            Assert.Contains(ChildId, refs.HardReaders);
            Assert.Contains(ChildId, refs.Unpruneable);
            Assert.Equal(refs.HardReaders.Union(refs.FilterDerivedNodes).OrderBy(x => x), refs.Unpruneable.OrderBy(x => x));

            var cols = TraversalColumnCollector.Collect(Tree(), groups, refs.Unpruneable);
            Assert.False(cols.ContainsKey(ChildId)); // mapping/template/mathexpr consumers read it
        }

        // ─── Message {root.col} tokens are root columns ─────────────────────────

        [Fact]
        public void Message_root_tokens_are_root_columns()
        {
            // Block/ShowMessage text renders against the root on Update/Delete too, where the root
            // read is column-scoped: a {root.col} the ColumnSet does not carry renders blank.
            var block = Active(ActionType.Block);
            block.Message = "Order {root.sample_ordernumber} is blocked.";
            block.LocalizedMessages = new Dictionary<int, string> { [1036] = "Commande {root.sample_reference} bloquée." };

            var cols = Refs(Group(RootCond()), block).RootColumns(Tree());

            Assert.Contains("sample_ordernumber", cols);
            Assert.Contains("sample_reference", cols);
        }

        // ─── isRootOnly considers every reference kind ─────────────────────────────

        [Fact]
        public void IsRootOnly_false_when_a_root_filter_reads_a_lookup_value_node()
        {
            var cond = RootCond();
            var group = Group(cond);
            group.NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = RootId, RuleConditionId = cond.Id,
                Criteria = { new NodeFilterCriterion { FieldName = "ownerid", Operator = "eq", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = LookupId, ComparisonValueColumn = "ownerid" } },
            });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_a_root_filter_has_an_exists_over_a_child_collection()
        {
            var cond = RootCond();
            var group = Group(cond);
            group.NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = RootId, RuleConditionId = cond.Id,
                Criteria = { new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = ChildId, MinCount = 1 } },
            });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_an_action_targets_a_non_root_node_and_true_when_it_targets_the_root()
        {
            var onLookup = Active(ActionType.UpdateRecord);
            onLookup.TargetNodeId = LookupId;
            Assert.False(Refs(Group(RootCond()), onLookup).IsRootOnly(Tree()));

            var onRoot = Active(ActionType.DeleteRecord);
            onRoot.TargetNodeId = RootId;
            Assert.True(Refs(Group(RootCond()), onRoot).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_a_condition_template_reads_a_lookup_node()
        {
            var group = Group(new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name",
                ValueSource = ComparisonValueSource.Template, ComparisonValue = $"{{node:{LookupId}.fullname}}",
            });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_a_date_expression_anchors_on_a_lookup_node()
        {
            var group = Group(new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "createdon",
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = $"{{\"anchor\":{{\"kind\":\"field\",\"node\":\"{LookupId}\",\"column\":\"birthdate\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}",
            });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_an_expression_scalar_reads_a_lookup_node()
        {
            var group = Group(new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression,
                Expression = $"{{root.amount}} * {{node:{LookupId}.rate}}", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            });
            Assert.False(Refs(group).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_a_mapping_copies_from_a_lookup_node()
        {
            var create = Active(ActionType.CreateRecord);
            create.FieldMapping = $"[{{\"target\":\"subject\",\"source\":\"node\",\"node\":\"{LookupId}\",\"column\":\"fullname\"}}]";
            Assert.False(Refs(Group(RootCond()), create).IsRootOnly(Tree()));
        }

        [Fact]
        public void IsRootOnly_false_when_a_message_token_reads_a_lookup_node()
        {
            var block = Active(ActionType.Block);
            block.Message = $"Contact {{node:{LookupId}.fullname}} says no.";
            Assert.False(Refs(Group(RootCond()), block).IsRootOnly(Tree()));
        }

        // ─── Behaviour change: inactive actions contribute nothing ──────────

        [Fact]
        public void Inactive_actions_contribute_no_nodes_or_columns()
        {
            var update = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, IsActive = false, TargetNodeId = LookupId,
                FieldMapping = $"[{{\"target\":\"a\",\"source\":\"root\",\"column\":\"revenue\"}},{{\"target\":\"b\",\"source\":\"node\",\"node\":\"{ChildId}\",\"column\":\"x\"}}]",
                Message = $"{{root.description}} {{node:{SiblingId}.name}}" };

            var refs = Refs(Group(RootCond()), update);

            Assert.DoesNotContain(LookupId, refs.NodesToLoad);
            Assert.DoesNotContain(ChildId, refs.NodesToLoad);
            Assert.Empty(refs.OptionalNodes);
            Assert.Empty(refs.HardReaders);
            Assert.True(refs.IsRootOnly(Tree()));
            var cols = refs.RootColumns(Tree());
            Assert.DoesNotContain("revenue", cols);
            Assert.DoesNotContain("description", cols);
        }

        // ─── Optional (message-only) nodes ──────────────────────────────────

        [Fact]
        public void Message_only_nodes_are_optional_and_structurally_referenced_nodes_are_required()
        {
            var block = Active(ActionType.Block);
            block.Message = $"{{node:{SiblingId}.name}} / {{node:{LookupId}.fullname}}";
            var group = Group(new RuleCondition { TableConfigNodeId = RootId, ComparisonColumn = "ownerid",
                ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = LookupId, ComparisonValueColumn = "ownerid" });

            var refs = Refs(group, block);

            Assert.Contains(SiblingId, refs.OptionalNodes);
            Assert.DoesNotContain(SiblingId, refs.NodesToLoad);
            Assert.Contains(LookupId, refs.NodesToLoad);        // also a field reference
            Assert.DoesNotContain(LookupId, refs.OptionalNodes);
            // Both are hard readers and planned either way.
            Assert.Contains(SiblingId, refs.HardReaders);
            Assert.Contains(SiblingId, refs.NodesToPlan);
            Assert.Contains(SiblingId, refs.Unpruneable);
        }

        // ─── Hard readers are built from their own kind list ────────────────

        [Fact]
        public void Filter_targets_are_filter_derived_not_hard_readers()
        {
            var cond = new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = ChildId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };
            var group = Group(cond);
            var valueNode = Guid.NewGuid();
            group.NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = ChildId, RuleConditionId = cond.Id,
                Criteria = { new NodeFilterCriterion { FieldName = "statecode", Operator = "eq", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = valueNode, ComparisonValueColumn = "statecode" } },
                ChildGroups = { new NodeFilterGroup { TableConfigNodeId = RootId, Criteria = { new NodeFilterCriterion { FieldName = "name", Operator = "not-null" } } } },
            });

            var refs = Refs(group);

            Assert.Empty(refs.HardReaders);
            Assert.Contains(ChildId, refs.FilterDerivedNodes);
            Assert.Contains(RootId, refs.FilterDerivedNodes);   // nested child group target
            Assert.Contains(valueNode, refs.FilterDerivedNodes);
            Assert.Contains(valueNode, refs.NodeIds(ReferenceKind.FilterValueNodes));
            Assert.Contains(ChildId, refs.NodesToPlan);
        }

        [Fact]
        public void Mapping_aggregate_filter_nodes_are_hard_readers_with_filter_key_provenance()
        {
            var create = Active(ActionType.CreateRecord);
            create.FieldMapping = "parsed-by-delegate";
            var entry = new Ascentix.RulesEngine.Core.Actions.FieldMappingEntry
            {
                Target = "total", Source = "mathexpr", Expression = $"sum(node:{ChildId}.amt filter:f1)",
                Filters = new Dictionary<string, NodeFilterGroup>
                {
                    ["f1"] = new NodeFilterGroup
                    {
                        Criteria = { new NodeFilterCriterion { FieldName = "ownerid", Operator = "eq", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = LookupId, ComparisonValueColumn = "ownerid" } },
                    },
                },
            };

            var refs = RuleReferences.Compute(Groups(Group(RootCond())), new[] { create },
                _ => new List<Ascentix.RulesEngine.Core.Actions.FieldMappingEntry> { entry });

            var agg = Assert.Single(refs.ReferencesByKind(ReferenceKind.MappingAggregateNodes));
            Assert.Equal(ChildId, agg.NodeId);
            Assert.Equal("f1", agg.FilterKey);
            Assert.Equal(create.Id, agg.ActionId);
            Assert.Contains(LookupId, refs.NodeIds(ReferenceKind.MappingFilterNodes));
            Assert.Contains(ChildId, refs.HardReaders);
            Assert.Contains(LookupId, refs.HardReaders);
            Assert.Empty(refs.FilterDerivedNodes);
        }

        // ─── Root columns from filters and sub-filters ──────────────────────

        [Fact]
        public void Root_side_criterion_field_reference_columns_and_exists_subfilter_root_columns_are_root_columns()
        {
            var cond = new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = ChildId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };
            var group = Group(cond);
            group.NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = ChildId, RuleConditionId = cond.Id,
                Criteria =
                {
                    // The criterion sits on the child but its RHS reads a root column.
                    new NodeFilterCriterion { FieldName = "amount", Operator = "gt", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = RootId, ComparisonValueColumn = "creditlimit" },
                    // An EXISTS sub-filter criterion whose RHS reads a root column.
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists, CollectionNodeId = SiblingId, MinCount = 1,
                        SubFilter = new NodeFilterGroup { Criteria = { new NodeFilterCriterion { FieldName = "sample_shipamount", Operator = "gt", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = RootId, ComparisonValueColumn = "sample_threshold" } } },
                    },
                },
            });

            var cols = Refs(group).RootColumns(Tree());

            Assert.Contains("creditlimit", cols);
            Assert.Contains("sample_threshold", cols);
            Assert.DoesNotContain("amount", cols);             // child column
            Assert.DoesNotContain("sample_shipamount", cols);  // sibling column
        }

        // ─── Lenient on payloads that do not parse ──────────────────────────

        [Fact]
        public void Malformed_payloads_contribute_nothing_and_do_not_throw()
        {
            var create = Active(ActionType.CreateRecord);
            create.FieldMapping = "{not json";
            var block = Active(ActionType.Block);
            block.Message = "unclosed {root.name";
            var group = Group(
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name", ValueSource = ComparisonValueSource.Template, ComparisonValue = "{" },
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name", ValueSource = ComparisonValueSource.DateExpression, ComparisonValue = "{\"op\":\"add\"}" },
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression, Expression = "sum(", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1" });

            var refs = Refs(group, create, block);

            Assert.Equal(new[] { RootId }, refs.NodesToLoad.ToArray());
            Assert.Empty(refs.HardReaders);
            Assert.True(refs.IsRootOnly(Tree()));
        }
    }
}
