using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests.Engine
{
    /// <summary>
    /// Rules × rows, table-driven, at the evaluation seam: every case is an
    /// <see cref="EvaluationInput"/> built by hand (tree, a cache with the roots already stored,
    /// groups, actions, dictionary-backed metadata, a fixed instant, a null-object trace) and an
    /// exact, ORDERED list of fired actions: type, FireOn, rendered message, write-intent values.
    /// No Dataverse, no FakeXrmEasy context: what <see cref="BucketEvaluator"/> decides is a
    /// function of the input alone. The facts below the table cover the trace-shaped and
    /// fault-shaped behaviours a verdict cannot express.
    /// </summary>
    public class RuleEvaluationTableTests
    {
        // ── Doubles ───────────────────────────────────────────────────────────

        private sealed class NullTrace : ITracingService
        {
            public void Trace(string format, params object[] args) { }
        }

        // Mimics the REAL ITracingService behavior: the actual Dataverse plugin sandbox
        // implementation (and Ascentix.RulesEngine.Plugin.LocalTracingService, which
        // wraps it) always routes the traced text through string.Format(message, args) --
        // UNCONDITIONALLY, even when args is empty -- because `message` is itself the format
        // string parameter. FakeXrmEasy's own XrmFakedTracingService just records the text
        // verbatim and never calls string.Format, which is why the suite once missed a
        // degrade-to-raw call that interpolated a brace-laden ex.Message directly into the traced
        // text: with no args to satisfy them, the literal '{oops.name}'-style braces make
        // string.Format throw FormatException, exactly like the real service.
        private sealed class FormatFaithfulTracingService : ITracingService
        {
            private readonly List<string> _lines = new List<string>();

            public void Trace(string message, params object[] args)
            {
                if (string.IsNullOrEmpty(message)) return;
                _lines.Add(string.Format(message, args ?? new object[0]));
            }

            public string DumpTrace() => string.Join(Environment.NewLine, _lines);
        }

        /// <summary>Column types per "table.column"; everything else is String. Labels none.</summary>
        private sealed class DictMetadata : IAttributeMetadataProvider, IOptionLabelProvider
        {
            private readonly Dictionary<string, AttributeTypeCode> _types =
                new Dictionary<string, AttributeTypeCode>(StringComparer.OrdinalIgnoreCase);
            private readonly Dictionary<string, string> _labels =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            public DictMetadata Type(string table, string column, AttributeTypeCode type)
            {
                _types[table + "." + column] = type;
                return this;
            }

            public DictMetadata Label(string table, string column, int value, string label)
            {
                _labels[table + "." + column + "#" + value] = label;
                return this;
            }

            public AttributeTypeCode? GetAttributeType(string table, string column) =>
                _types.TryGetValue(table + "." + column, out var t) ? t : AttributeTypeCode.String;

            public string GetOptionLabel(string table, string column, int value) =>
                _labels.TryGetValue(table + "." + column + "#" + value, out var l) ? l : null;
        }

        // ── Case shape ────────────────────────────────────────────────────────

        private sealed class Expected
        {
            public ActionType Type;
            public ActionFireOn FireOn;
            public string Message;
            public Dictionary<string, object> Values;   // null ⇒ no write intent expected
            public string TargetTable;
            public Guid? TargetId;
            public bool? RootTargeted;
        }

        private sealed class Case
        {
            public EvaluationInput Input;
            public List<List<Expected>> ExpectedByRecord;
        }

        private static readonly DateTime Now = new DateTime(2026, 8, 23, 12, 0, 0, DateTimeKind.Utc);

        private static Expected Fired(ActionType type, ActionFireOn fireOn, string message = null,
            Dictionary<string, object> values = null) =>
            new Expected { Type = type, FireOn = fireOn, Message = message, Values = values };

        private static object Normalize(object v)
        {
            switch (v)
            {
                case Money m: return m.Value;
                case OptionSetValue o: return o.Value;
                case EntityReference r: return r.Id;
                default: return v;
            }
        }

        // ── Fixture builders ──────────────────────────────────────────────────

        private static Guid NewId() => Guid.NewGuid();

        private static ConditionGroup Group(Guid ruleId, bool execution, params RuleCondition[] conditions) =>
            new ConditionGroup
            {
                Id = NewId(),
                RuleId = ruleId,
                LogicalOperator = LogicalOperator.And,
                IsExecutionCondition = execution,
                Conditions = conditions.ToList(),
            };

        private static RuleCondition Compare(Guid node, string column, ComparisonOperator op, string value = null) =>
            new RuleCondition
            {
                Id = NewId(),
                TableConfigNodeId = node,
                ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = column,
                ComparisonOperator = op,
                ComparisonValue = value,
            };

        private static RuleAction Message(Guid ruleId, ActionType type, ActionFireOn fireOn, string text, int order,
            Dictionary<int, string> localized = null) =>
            new RuleAction
            {
                Id = NewId(),
                RuleId = ruleId,
                ActionType = type,
                FireOn = fireOn,
                Message = text,
                Order = order,
                IsActive = true,
                LocalizedMessages = localized ?? new Dictionary<int, string>(),
            };

        private static RuleAction Create(Guid ruleId, string table, string mapping, int order = 1) =>
            new RuleAction
            {
                Id = NewId(),
                RuleId = ruleId,
                ActionType = ActionType.CreateRecord,
                FireOn = ActionFireOn.OnMatch,
                TargetTable = table,
                FieldMapping = mapping,
                Order = order,
                IsActive = true,
            };

        private const string SubjectHello = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hello\"}]";

        /// <summary>account root only. The rule: name == "Acme" (main group). Two message
        /// actions OnMatch: ShowMessage (order 1) then Block (order 2).</summary>
        private static (EvaluationInput input, Guid rule) AcmeRoot(
            string showText, string blockText, string rootName = "Acme", int languageId = 1033,
            Dictionary<int, string> localizedShow = null)
        {
            var rootId = NewId();
            var rule = NewId();
            var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
            var root = TestTree.Row("account", NewId(), ("name", rootName));
            var cache = TestTree.Cache((rootId, new List<Entity> { root }));
            var groups = new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Acme")) };
            var actions = new[]
            {
                Message(rule, ActionType.ShowMessage, ActionFireOn.OnMatch, showText, 1, localizedShow),
                Message(rule, ActionType.Block, ActionFireOn.OnMatch, blockText, 2),
            };
            return (TestTree.Input(tree, cache, root, groups, actions, new DictMetadata(), languageId: languageId, utcNow: Now), rule);
        }

        /// <summary>account root → contact lookup (primarycontactid). The rule's one condition
        /// is on the ROOT; the lookup node is referenced only by message tokens. The contact rows
        /// given are what the lookup node's cache entry holds.</summary>
        private static (EvaluationInput input, Guid lookupCfg) AcmeWithContact(
            Func<Guid, string> showText, Func<Guid, string> blockText, params Entity[] contacts)
        {
            var rootId = NewId();
            var lookupId = NewId();
            var rule = NewId();
            var lookup = TestTree.Node(lookupId, "contact", TableConfigType.LookupTable, rootId);
            lookup.LookupColumnLogicalName = "primarycontactid";
            lookup.LookupTargetIdAttribute = "contactid";
            var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null), lookup);
            var contactRef = contacts.Length > 0 ? new EntityReference("contact", contacts[0].Id) : null;
            var root = TestTree.Row("account", NewId(), ("name", "Acme"), ("primarycontactid", contactRef));
            var cache = TestTree.Cache(
                (rootId, new List<Entity> { root }),
                (lookupId, contacts.ToList()));
            var groups = new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Acme")) };
            var actions = new List<RuleAction>
            {
                Message(rule, ActionType.ShowMessage, ActionFireOn.OnMatch, showText(lookupId), 1),
            };
            if (blockText != null)
                actions.Add(Message(rule, ActionType.Block, ActionFireOn.OnMatch, blockText(lookupId), 2));
            return (TestTree.Input(tree, cache, root, groups, actions, new DictMetadata(), utcNow: Now), lookupId);
        }

        /// <summary>sample_order root → sample_orderline child (sample_orderid) [+ sample_shipment
        /// child (sample_shipmentorderid)]. Cache holds the root and the given rows per node.</summary>
        private static (TableConfigTree tree, Guid rootCfg, Guid lineCfg, Guid shipmentCfg, Entity root, QueryResultCache cache)
            OrderTree(IEnumerable<Entity> lines, IEnumerable<Entity> shipments = null)
        {
            var rootCfg = NewId();
            var lineCfg = NewId();
            var shipmentCfg = NewId();
            var nodes = new List<TableConfig>
            {
                TestTree.Node(rootCfg, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(lineCfg, "sample_orderline", TableConfigType.ChildTable, rootCfg, "sample_orderid"),
            };
            if (shipments != null)
                nodes.Add(TestTree.Node(shipmentCfg, "sample_shipment", TableConfigType.ChildTable, rootCfg, "sample_shipmentorderid"));
            var tree = TestTree.Tree(nodes.ToArray());
            var root = TestTree.Row("sample_order", NewId(), ("name", "Order A"));
            var entries = new List<(Guid, List<Entity>)>
            {
                (rootCfg, new List<Entity> { root }),
                (lineCfg, lines.Select(l => Link(l, "sample_orderid", root)).ToList()),
            };
            if (shipments != null)
                entries.Add((shipmentCfg, shipments.Select(s => Link(s, "sample_shipmentorderid", root)).ToList()));
            return (tree, rootCfg, lineCfg, shipmentCfg, root, TestTree.Cache(entries.ToArray()));
        }

        private static Entity Link(Entity row, string linkField, Entity parent)
        {
            row[linkField] = new EntityReference(parent.LogicalName, parent.Id);
            return row;
        }

        private static Entity Line(decimal amount) =>
            TestTree.Row("sample_orderline", NewId(), ("lineamount", new Money(amount)));

        private static Entity Shipment(string status) =>
            TestTree.Row("sample_shipment", NewId(), ("statuscode", status));

        /// <summary>RowCount(line, min 1) filtered by EXISTS(shipment, min 1, statuscode eq
        /// expedited); CreateRecord task subject=Hello OnMatch.</summary>
        private static EvaluationInput ExistsInput(string shipmentStatus)
        {
            var (tree, _, lineCfg, shipmentCfg, root, cache) = OrderTree(
                new[] { TestTree.Row("sample_orderline", NewId()) }, new[] { Shipment(shipmentStatus) });
            var rule = NewId();
            var rowCount = new RuleCondition
            {
                Id = NewId(),
                TableConfigNodeId = lineCfg,
                ConditionType = ConditionType.RowCount,
                MinExpectedRows = 1,
            };
            var group = Group(rule, false, rowCount);
            group.NodeFilterGroups.Add(new NodeFilterGroup
            {
                Id = NewId(),
                TableConfigNodeId = lineCfg,
                RuleConditionId = rowCount.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists,
                        CollectionNodeId = shipmentCfg,
                        MinCount = 1,
                        SubFilter = new NodeFilterGroup
                        {
                            LogicalOperator = LogicalOperator.And,
                            Criteria = new List<NodeFilterCriterion>
                            {
                                new NodeFilterCriterion { FieldName = "statuscode", Operator = "eq", Value = "expedited" },
                            },
                        },
                    },
                },
            });
            return TestTree.Input(tree, cache, root, new[] { group }, new[] { Create(rule, "task", SubjectHello) },
                new DictMetadata(), utcNow: Now, trigger: RuleTrigger.OnCreate);
        }

        /// <summary>EXECUTION group: sum(node:line.lineamount) > 100; CreateRecord task
        /// subject=Hello OnMatch with no main groups (vacuously matched).</summary>
        private static EvaluationInput ChildSumGateInput(params decimal[] lineAmounts)
        {
            var (tree, rootCfg, lineCfg, _, root, cache) = OrderTree(lineAmounts.Select(Line));
            var rule = NewId();
            var gate = Group(rule, true, new RuleCondition
            {
                Id = NewId(),
                TableConfigNodeId = rootCfg,
                ConditionType = ConditionType.Expression,
                Expression = "sum(node:" + lineCfg + ".lineamount)",
                ComparisonOperator = ComparisonOperator.GreaterThan,
                ComparisonValue = "100",
            });
            return TestTree.Input(tree, cache, root, new[] { gate }, new[] { Create(rule, "task", SubjectHello) },
                new DictMetadata(), utcNow: Now, trigger: RuleTrigger.OnCreate);
        }

        private static Dictionary<string, object> Values(params (string col, object val)[] pairs) =>
            pairs.ToDictionary(p => p.col, p => p.val);

        private static Case Single(EvaluationInput input, params Expected[] expected) =>
            new Case { Input = input, ExpectedByRecord = new List<List<Expected>> { expected.ToList() } };

        // ── The table ─────────────────────────────────────────────────────────

        private const string DefaultMessage = "This record violates a validation rule and cannot be saved.";

        private static readonly Dictionary<string, Func<Case>> Table = new Dictionary<string, Func<Case>>
        {
            // RulesEngineRunnerTests: Block OnNoMatch fires when the condition fails; nothing
            // fires when it holds.
            ["block_on_no_match_fires_when_rule_fails"] = () =>
            {
                var rootId = NewId();
                var rule = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var root = TestTree.Row("account", NewId(), ("name", "Invalid"));
                var cache = TestTree.Cache((rootId, new List<Entity> { root }));
                var input = TestTree.Input(tree, cache, root,
                    new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Valid")) },
                    new[] { Message(rule, ActionType.Block, ActionFireOn.OnNoMatch, "Name must be Valid.", 1) },
                    new DictMetadata(), utcNow: Now);
                return Single(input, Fired(ActionType.Block, ActionFireOn.OnNoMatch, "Name must be Valid."));
            },
            ["nothing_fires_when_rule_matches"] = () =>
            {
                var rootId = NewId();
                var rule = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var root = TestTree.Row("account", NewId(), ("name", "Valid"));
                var cache = TestTree.Cache((rootId, new List<Entity> { root }));
                var input = TestTree.Input(tree, cache, root,
                    new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Valid")) },
                    new[] { Message(rule, ActionType.Block, ActionFireOn.OnNoMatch, "Name must be Valid.", 1) },
                    new DictMetadata(), utcNow: Now);
                return Single(input);
            },

            // DynamicMessageTests: {root.col} and {node:guid.col} tokens render at fire time;
            // an unknown token degrades to the raw text and the rule still fires.
            ["root_token_renders_in_show_message_and_block"] = () =>
                Single(AcmeRoot("Total for {root.name}.", "Blocked: {root.name}.").input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "Total for Acme."),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, "Blocked: Acme.")),
            ["unknown_token_degrades_to_raw_text_and_rule_still_fires"] = () =>
                Single(AcmeRoot("Total for {oops.name}.", "Blocked: {root.name}.").input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "Total for {oops.name}."),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, "Blocked: Acme.")),
            ["localized_message_with_token_renders_in_selected_language"] = () =>
                Single(AcmeRoot("Total for {root.name}.", "Blocked: {root.name}.", languageId: 1036,
                        localizedShow: new Dictionary<int, string> { [1036] = "Total pour {root.name}." }).input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "Total pour Acme."),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, "Blocked: Acme.")),
            ["message_with_no_tokens_renders_unchanged"] = () =>
                Single(AcmeRoot("Just a plain message, no tokens.", "Also plain, no tokens.").input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "Just a plain message, no tokens."),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, "Also plain, no tokens.")),
            // An empty configured Message never reaches the renderer as "": MessageResolver
            // substitutes the engine's localized default, which itself has no tokens.
            ["empty_message_falls_back_to_the_engine_default"] = () =>
                Single(AcmeRoot("", "").input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, DefaultMessage),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, DefaultMessage)),
            ["node_token_renders_the_related_records_value"] = () =>
                Single(AcmeWithContact(id => $"Contact: {{node:{id}.fullname}}.", null,
                        TestTree.Row("contact", NewId(), ("fullname", "Sam Roe"))).input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "Contact: Sam Roe.")),
            // The referenced guid is simply never in the rule's config tree: TemplateRenderer's
            // "not in the rule's config tree" throw, swallowed by the degrade catch. The root
            // token in the OTHER message still renders.
            ["node_token_on_unknown_node_degrades_to_raw_text"] = () =>
            {
                var unknown = NewId();
                var (input, _) = AcmeRoot($"Contact: {{node:{unknown}.fullname}}.", "Blocked: {root.name}.");
                return Single(input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, $"Contact: {{node:{unknown}.fullname}}."),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, "Blocked: Acme."));
            },
            // A misconfigured lookup whose fetch resolved two records for one root reference:
            // TemplateRenderer's ">1 records; expected at most one" throw, swallowed by the
            // degrade catch in both the ShowMessage and the Block path.
            ["node_token_on_multi_record_node_degrades_to_raw_text"] = () =>
            {
                var (input, lookupCfg) = AcmeWithContact(
                    id => $"Contact: {{node:{id}.fullname}}.",
                    id => $"Blocked: {{node:{id}.fullname}}.",
                    TestTree.Row("contact", NewId(), ("fullname", "Sam Roe")),
                    TestTree.Row("contact", NewId(), ("fullname", "Alex Kim")));
                return Single(input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, $"Contact: {{node:{lookupCfg}.fullname}}."),
                    Fired(ActionType.Block, ActionFireOn.OnMatch, $"Blocked: {{node:{lookupCfg}.fullname}}."));
            },

            // RunnerExistsCriterionTests: the EXISTS criterion's sub-filter drives the verdict, so
            // an expedited shipment lets the line count, a standard one filters it out.
            ["exists_criterion_matches_when_a_related_shipment_is_expedited"] = () =>
                Single(ExistsInput("expedited"),
                    Fired(ActionType.CreateRecord, ActionFireOn.OnMatch, values: Values(("subject", "Hello")))),
            ["exists_criterion_does_not_match_when_no_shipment_is_expedited"] = () =>
                Single(ExistsInput("standard")),

            // RunnerWriteIntentTests: a fired write action carries its resolved WriteIntent.
            ["create_record_has_resolved_write_intent"] = () =>
            {
                var rootId = NewId();
                var rule = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var root = TestTree.Row("account", NewId(), ("name", "Acme Corp"));
                var cache = TestTree.Cache((rootId, new List<Entity> { root }));
                var input = TestTree.Input(tree, cache, root,
                    new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.IsNotNull)) },
                    new[] { Create(rule, "task", SubjectHello) },
                    new DictMetadata(), utcNow: Now, trigger: RuleTrigger.OnCreate);
                return Single(input, new Expected
                {
                    Type = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch,
                    Values = Values(("subject", "Hello")), TargetTable = "task", RootTargeted = false,
                });
            },
            // No condition groups at all: All() over empty is true, the rule matches, and the
            // UpdateRecord on the root node resolves against the root's own identity.
            ["update_record_on_root_with_no_conditions_has_resolved_write_intent"] = () =>
            {
                var rootId = NewId();
                var rule = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var root = TestTree.Row("account", NewId(), ("name", "Old Name"));
                var cache = TestTree.Cache((rootId, new List<Entity> { root }));
                var update = new RuleAction
                {
                    Id = NewId(), RuleId = rule, ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch,
                    TargetNodeId = rootId, Order = 1, IsActive = true,
                    FieldMapping = "[{\"target\":\"name\",\"source\":\"literal\",\"value\":\"Patched\"}]",
                };
                var input = TestTree.Input(tree, cache, root, null, new[] { update },
                    new DictMetadata(), utcNow: Now, trigger: RuleTrigger.OnCreate);
                return Single(input, new Expected
                {
                    Type = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch,
                    Values = Values(("name", "Patched")), TargetTable = "account", TargetId = root.Id, RootTargeted = true,
                });
            },
            ["create_record_mathexpr_writes_the_computed_value_coerced_to_the_target_type"] = () =>
            {
                var rootId = NewId();
                var rule = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var root = TestTree.Row("account", NewId(), ("name", "Acme Corp"), ("numberofemployees", 3));
                var cache = TestTree.Cache((rootId, new List<Entity> { root }));
                var input = TestTree.Input(tree, cache, root,
                    new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.IsNotNull)) },
                    new[] { Create(rule, "task", "[{\"target\":\"amount\",\"source\":\"mathexpr\",\"expression\":\"{root.numberofemployees} * 2\"}]") },
                    new DictMetadata().Type("task", "amount", AttributeTypeCode.Money), utcNow: Now, trigger: RuleTrigger.OnCreate);
                return Single(input, Fired(ActionType.CreateRecord, ActionFireOn.OnMatch, values: Values(("amount", 6m))));
            },

            // The execution-condition gate runs BEFORE the main groups: when it fails nothing
            // fires at all (not even OnNoMatch); when it passes, the (empty) main groups match.
            ["execution_condition_passes_when_child_sum_exceeds_threshold"] = () =>
                Single(ChildSumGateInput(50m, 70m),
                    Fired(ActionType.CreateRecord, ActionFireOn.OnMatch, values: Values(("subject", "Hello")))),
            ["execution_condition_blocks_every_action_when_child_sum_is_below_threshold"] = () =>
                Single(ChildSumGateInput(10m, 20m)),
            ["failed_execution_condition_skips_on_no_match_actions_too"] = () =>
            {
                var input = ChildSumGateInput(10m, 20m);
                var rule = input.RuleIds.Single();
                var actions = input.ActionsByRule[rule].ToList();
                actions.Add(Message(rule, ActionType.Block, ActionFireOn.OnNoMatch, "never", 2));
                var rebuilt = TestTree.Input(input.Tree, input.Records[0].Cache, input.Records[0].Root,
                    input.RootGroups, actions, input.Metadata, utcNow: Now, trigger: RuleTrigger.OnCreate);
                return Single(rebuilt);
            },

            // Order: rules in loader order, actions by Order within a rule.
            ["rules_fire_in_loader_order_and_actions_by_order_within_a_rule"] = () =>
            {
                var rootId = NewId();
                var ruleA = NewId();
                var ruleB = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var root = TestTree.Row("account", NewId(), ("name", "Acme"));
                var cache = TestTree.Cache((rootId, new List<Entity> { root }));
                var input = TestTree.Input(tree, cache, root,
                    new[]
                    {
                        Group(ruleB, false, Compare(rootId, "name", ComparisonOperator.IsNotNull)),
                        Group(ruleA, false, Compare(rootId, "name", ComparisonOperator.IsNotNull)),
                    },
                    new[]
                    {
                        Message(ruleA, ActionType.ShowMessage, ActionFireOn.OnMatch, "A2", 2),
                        Message(ruleB, ActionType.ShowMessage, ActionFireOn.OnMatch, "B1", 1),
                        Message(ruleA, ActionType.ShowMessage, ActionFireOn.OnMatch, "A1", 1),
                    },
                    new DictMetadata(), utcNow: Now, ruleIds: new[] { ruleA, ruleB });
                return Single(input,
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "A1"),
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "A2"),
                    Fired(ActionType.ShowMessage, ActionFireOn.OnMatch, "B1"));
            },

            // One cache per record: each record's verdict reads only its own rows.
            ["each_record_is_judged_against_its_own_cache"] = () =>
            {
                var rootId = NewId();
                var rule = NewId();
                var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
                var good = TestTree.Row("account", NewId(), ("name", "Valid"));
                var bad = TestTree.Row("account", NewId(), ("name", "Invalid"));
                var input = TestTree.Input(tree,
                    new[]
                    {
                        (good, TestTree.Cache((rootId, new List<Entity> { good }))),
                        (bad, TestTree.Cache((rootId, new List<Entity> { bad }))),
                    },
                    new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Valid")) },
                    new[] { Message(rule, ActionType.Block, ActionFireOn.OnNoMatch, "Name must be Valid for {root.name}.", 1) },
                    new DictMetadata(), utcNow: Now);
                return new Case
                {
                    Input = input,
                    ExpectedByRecord = new List<List<Expected>>
                    {
                        new List<Expected>(),
                        new List<Expected> { Fired(ActionType.Block, ActionFireOn.OnNoMatch, "Name must be Valid for Invalid.") },
                    },
                };
            },
        };

        public static IEnumerable<object[]> Cases() => Table.Keys.Select(k => new object[] { k });

        [Theory]
        [MemberData(nameof(Cases))]
        public void Rules_x_rows(string name)
        {
            var c = Table[name]();

            var verdict = BucketEvaluator.Evaluate(c.Input, new NullTrace());

            Assert.Equal(c.ExpectedByRecord.Count, verdict.FiredByRecord.Count);
            for (var r = 0; r < c.ExpectedByRecord.Count; r++)
            {
                var expected = c.ExpectedByRecord[r];
                var actual = verdict.FiredByRecord[r];
                Assert.Equal(expected.Count, actual.Count);
                for (var i = 0; i < expected.Count; i++)
                {
                    var e = expected[i];
                    var a = actual[i];
                    Assert.Equal(e.Type, a.ActionType);
                    Assert.Equal(e.FireOn, a.FireOn);
                    Assert.Equal(e.Message, a.Message);
                    if (e.Values == null)
                    {
                        Assert.Null(a.WriteIntent);
                        continue;
                    }
                    Assert.NotNull(a.WriteIntent);
                    Assert.Equal(
                        e.Values.OrderBy(k => k.Key).Select(k => (k.Key, Normalize(k.Value))),
                        a.WriteIntent.Values.OrderBy(k => k.Key).Select(k => (k.Key, Normalize(k.Value))));
                    if (e.TargetTable != null) Assert.Equal(e.TargetTable, a.WriteIntent.TargetTable);
                    if (e.TargetId.HasValue) Assert.Equal(e.TargetId, a.WriteIntent.TargetId);
                    if (e.RootTargeted.HasValue) Assert.Equal(e.RootTargeted.Value, a.WriteIntent.RootTargeted);
                }
            }
        }

        // ── Facts a verdict cannot express ────────────────────────────────────

        [Fact]
        public void Unknown_token_degrade_traces_a_warning()
        {
            var (input, _) = AcmeRoot("Total for {oops.name}.", "Blocked: {root.name}.");
            var trace = new XrmFakedTracingService();

            BucketEvaluator.Evaluate(input, trace);

            Assert.Contains("Message token render failed", trace.DumpTrace());
        }

        // CRITICAL regression: the degrade-to-raw catch block traces ex.Message (which itself
        // contains literal '{oops.name}'-style braces from TemplateRenderer's own error text).
        // Against the real ITracingService, interpolating that text directly INTO the format
        // string (rather than passing it as a format ARG) makes string.Format re-parse the
        // braces and throw FormatException, which the real service turns into
        // InvalidPluginExecutionException -- escaping the enclosing catch and blocking the save.
        // One fact per degrade path: unknown {root-ish} token, unknown node, multi-record node.
        [Theory]
        [InlineData("unknown_token_degrades_to_raw_text_and_rule_still_fires")]
        [InlineData("node_token_on_unknown_node_degrades_to_raw_text")]
        [InlineData("node_token_on_multi_record_node_degrades_to_raw_text")]
        public void Degrade_trace_does_not_throw_against_real_tracing_semantics(string name)
        {
            var c = Table[name]();
            var trace = new FormatFaithfulTracingService();

            EvaluationVerdict verdict = null;
            var thrown = Record.Exception(() => verdict = BucketEvaluator.Evaluate(c.Input, trace));

            Assert.Null(thrown);
            var fired = verdict.FiredByRecord.Single();
            Assert.Equal(c.ExpectedByRecord.Single().Select(e => e.Message), fired.Select(a => a.Message));
            Assert.Contains("Message token render failed", trace.DumpTrace());
        }

        // The memo crosses the seam on the input. A mapping absent from it parses on demand,
        // so a malformed mapping still faults only when its action fires, never before.
        [Fact]
        public void Mapping_absent_from_the_memo_is_parsed_when_the_action_fires()
        {
            var rootId = NewId();
            var rule = NewId();
            var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
            var root = TestTree.Row("account", NewId(), ("name", "Acme"));
            var cache = TestTree.Cache((rootId, new List<Entity> { root }));
            var input = TestTree.Input(tree, cache, root, null, new[] { Create(rule, "task", SubjectHello) },
                new DictMetadata(), utcNow: Now, mappings: new Dictionary<Guid, List<FieldMappingEntry>>());

            var fired = BucketEvaluator.Evaluate(input, new NullTrace()).FiredByRecord.Single().Single();

            Assert.Equal("Hello", fired.WriteIntent.Values["subject"]);
        }

        [Fact]
        public void Malformed_mapping_faults_only_when_its_action_fires()
        {
            var rootId = NewId();
            var rule = NewId();
            var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
            var root = TestTree.Row("account", NewId(), ("name", "Acme"));
            var cache = TestTree.Cache((rootId, new List<Entity> { root }));
            var bad = Create(rule, "task", "not json at all");
            var empty = new Dictionary<Guid, List<FieldMappingEntry>>();

            // Condition fails → the OnMatch action never fires → no parse, no fault.
            var dormant = TestTree.Input(tree, cache, root,
                new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Other")) },
                new[] { bad }, new DictMetadata(), utcNow: Now, mappings: empty);
            Assert.Empty(BucketEvaluator.Evaluate(dormant, new NullTrace()).FiredByRecord.Single());

            // Condition holds → the action fires → the mapping parses → the fault surfaces raw.
            var firing = TestTree.Input(tree, cache, root,
                new[] { Group(rule, false, Compare(rootId, "name", ComparisonOperator.Equals, "Acme")) },
                new[] { bad }, new DictMetadata(), utcNow: Now, mappings: empty);
            Assert.Throws<InvalidPluginExecutionException>(() => BucketEvaluator.Evaluate(firing, new NullTrace()));
        }

        [Fact]
        public void Write_intent_is_stamped_with_the_inputs_context()
        {
            var rootId = NewId();
            var rule = NewId();
            var tree = TestTree.Tree(TestTree.Node(rootId, "account", TableConfigType.RootTable, null));
            var root = TestTree.Row("account", NewId(), ("name", "Acme"));
            var cache = TestTree.Cache((rootId, new List<Entity> { root }));
            var input = TestTree.Input(tree, cache, root, null, new[] { Create(rule, "task", SubjectHello) },
                new DictMetadata(), utcNow: Now, context: RuleEvaluationContext.System);

            var fired = BucketEvaluator.Evaluate(input, new NullTrace()).FiredByRecord.Single().Single();

            Assert.Equal(RuleEvaluationContext.System, fired.WriteIntent.Context);
        }
    }
}
