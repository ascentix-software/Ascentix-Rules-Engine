using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    // Data update 1: On match / On no match (asx_fireon) to outcomes and Fires when trees, ported from the
    // one-time Convert-RulesToOutcomes.ps1 script it replaced.
    public class OutcomeConversionUpdateTests
    {
        private const int OnMatch = 1, OnNoMatch = 2, All = 1, Any = 2;
        private static readonly DateTime T0 = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);

        private readonly XrmFakedContext _ctx = new XrmFakedContext();
        private readonly List<Entity> _rows = new List<Entity>();
        private readonly OutcomeConversionUpdate _update = new OutcomeConversionUpdate();
        private int _minute;

        private IOrganizationService Service => _ctx.GetOrganizationService();

        private Guid Rule(string name = "Rule", int status = 1, Guid? pointer = null, Guid? draftOf = null)
        {
            var id = Guid.NewGuid();
            var rule = new Entity("asx_rule", id) { ["asx_name"] = name, ["statuscode"] = new OptionSetValue(status) };
            if (pointer.HasValue) rule[PublicationSchema.Pointer] = new EntityReference(PublicationSchema.Revision, pointer.Value);
            if (draftOf.HasValue) rule[PublicationSchema.DraftOf] = new EntityReference("asx_rule", draftOf.Value);
            _rows.Add(rule);
            return id;
        }

        private Guid Group(Guid rule, string name, bool? execution = false, Guid? parent = null)
        {
            var id = Guid.NewGuid();
            var group = new Entity("asx_conditiongroup", id)
            {
                ["asx_name"] = name, ["asx_rule"] = new EntityReference("asx_rule", rule), ["createdon"] = T0.AddMinutes(_minute++),
            };
            if (execution.HasValue) group["asx_isexecutioncondition"] = execution.Value;
            if (parent.HasValue) group["asx_parentconditiongroup"] = new EntityReference("asx_conditiongroup", parent.Value);
            _rows.Add(group);
            return id;
        }

        private Guid Action(Guid rule, int? fireOn, string name = "Act")
        {
            var id = Guid.NewGuid();
            var action = new Entity("asx_ruleaction", id)
            {
                ["asx_name"] = name, ["asx_rule"] = new EntityReference("asx_rule", rule), ["asx_isactive"] = true,
            };
            if (fireOn.HasValue) action[OutcomeConversionUpdate.FireOn] = new OptionSetValue(fireOn.Value);
            _rows.Add(action);
            return id;
        }

        private DataUpdateStep Run(Func<bool> overBudget = null, string cursor = null)
        {
            if (_rows.Count > 0) { _ctx.Initialize(_rows); _rows.Clear(); }
            return _update.RunStep(new DataUpdateContext(Service, null, Guid.NewGuid()), cursor, overBudget ?? (() => false));
        }

        private List<Entity> All_(string entity) =>
            Service.RetrieveMultiple(new QueryExpression(entity) { ColumnSet = new ColumnSet(true) }).Entities.ToList();

        private Entity Root(Guid action) => All_("asx_actionconditiongroup")
            .Single(g => g.GetAttributeValue<EntityReference>("asx_ruleaction").Id == action && !g.Contains("asx_parentgroup"));

        private List<Entity> Tests(Guid root) => All_("asx_actionconditiontest")
            .Where(t => t.GetAttributeValue<EntityReference>("asx_actionconditiongroup").Id == root)
            .OrderBy(t => t.GetAttributeValue<int>("asx_order")).ToList();

        private Entity Get(string entity, Guid id) => Service.Retrieve(entity, id, new ColumnSet(true));

        [Fact]
        public void On_match_becomes_ALL_of_each_outcome_is_true_and_clears_fire_on()
        {
            var rule = Rule();
            var credit = Group(rule, "Credit ok");
            var lines = Group(rule, "Has lines");
            var action = Action(rule, OnMatch);

            var step = Run();

            Assert.True(step.Done);
            Assert.Equal(1, step.Succeeded);
            var root = Root(action);
            Assert.Equal(OutcomeConversionUpdate.StableId(action + "/root"), root.Id);
            Assert.Equal(All, root.GetAttributeValue<OptionSetValue>("asx_logicaloperator").Value);
            var tests = Tests(root.Id);
            Assert.Equal(new[] { credit, lines }, tests.Select(t => t.GetAttributeValue<EntityReference>("asx_outcome").Id));
            Assert.All(tests, t => Assert.True(t.GetAttributeValue<bool>("asx_expected")));
            Assert.False(Get("asx_ruleaction", action).Contains(OutcomeConversionUpdate.FireOn));
        }

        [Fact]
        public void On_no_match_becomes_ANY_of_each_outcome_is_false()
        {
            var rule = Rule();
            Group(rule, "Credit ok");
            Group(rule, "Has lines");
            var action = Action(rule, OnNoMatch);

            Run();

            var root = Root(action);
            Assert.Equal(Any, root.GetAttributeValue<OptionSetValue>("asx_logicaloperator").Value);
            Assert.All(Tests(root.Id), t => Assert.False(t.GetAttributeValue<bool>("asx_expected")));
            Assert.True(Get("asx_ruleaction", action).GetAttributeValue<bool>("asx_isactive"));
        }

        [Fact]
        public void With_no_outcomes_on_match_always_fires_and_on_no_match_is_deactivated()
        {
            var rule = Rule();
            Group(rule, "Run only when", execution: true);
            var always = Action(rule, OnMatch, "Always");
            var never = Action(rule, OnNoMatch, "Never");

            Run();

            Assert.Empty(Tests(Root(always).Id)); // an empty ALL: always, when the rule runs
            Assert.DoesNotContain(All_("asx_actionconditiongroup"), g => g.GetAttributeValue<EntityReference>("asx_ruleaction").Id == never);
            var deactivated = Get("asx_ruleaction", never);
            Assert.False(deactivated.GetAttributeValue<bool>("asx_isactive"));
            Assert.False(deactivated.Contains(OutcomeConversionUpdate.FireOn));
        }

        [Fact]
        public void A_null_run_only_when_flag_is_an_outcome_and_nested_groups_are_not()
        {
            var rule = Rule();
            var outcome = Group(rule, "Unflagged", execution: null);
            Group(rule, "Nested", parent: outcome);
            var action = Action(rule, OnMatch);

            Run();

            Assert.Equal(new[] { outcome }, Tests(Root(action).Id).Select(t => t.GetAttributeValue<EntityReference>("asx_outcome").Id));
        }

        [Fact]
        public void Blank_and_repeated_outcome_names_are_made_unique()
        {
            var rule = Rule();
            var blank = Group(rule, "  ");
            var first = Group(rule, "Credit");
            var repeat = Group(rule, "credit");
            var taken = Group(rule, "Outcome 1");
            Action(rule, OnMatch);

            Run();

            Assert.Equal("Outcome 2", Get("asx_conditiongroup", blank).GetAttributeValue<string>("asx_name"));
            Assert.Equal("Credit", Get("asx_conditiongroup", first).GetAttributeValue<string>("asx_name"));
            Assert.Equal("credit (2)", Get("asx_conditiongroup", repeat).GetAttributeValue<string>("asx_name"));
            Assert.Equal("Outcome 1", Get("asx_conditiongroup", taken).GetAttributeValue<string>("asx_name"));
        }

        [Fact]
        public void A_repeated_name_at_the_column_limit_is_shortened_to_fit_its_suffix()
        {
            var name = new string('x', OutcomeConversionUpdate.MaxOutcomeName);
            var outcomes = new[] { new Entity("asx_conditiongroup", Guid.NewGuid()) { ["asx_name"] = name },
                                   new Entity("asx_conditiongroup", Guid.NewGuid()) { ["asx_name"] = name } };
            var renamed = OutcomeConversionUpdate.OutcomeNames(outcomes)[outcomes[1].Id];
            Assert.Equal(OutcomeConversionUpdate.MaxOutcomeName, renamed.Length);
            Assert.EndsWith(" (2)", renamed);
        }

        [Fact]
        public void An_existing_tree_is_kept_and_only_fire_on_is_cleared()
        {
            var rule = Rule();
            Group(rule, "Credit");
            var action = Action(rule, OnMatch);
            var theirs = Guid.NewGuid();
            _rows.Add(new Entity("asx_actionconditiongroup", theirs)
            {
                ["asx_ruleaction"] = new EntityReference("asx_ruleaction", action),
                ["asx_logicaloperator"] = new OptionSetValue(Any), ["asx_order"] = 1,
            });

            Run();

            Assert.Equal(theirs, Root(action).Id);
            Assert.Empty(Tests(theirs));
            Assert.False(Get("asx_ruleaction", action).Contains(OutcomeConversionUpdate.FireOn));
        }

        [Fact]
        public void A_tree_this_update_started_is_completed_not_duplicated()
        {
            var rule = Rule();
            var a = Group(rule, "A");
            var b = Group(rule, "B");
            var action = Action(rule, OnMatch);
            var rootId = OutcomeConversionUpdate.StableId(action + "/root");
            _rows.Add(new Entity("asx_actionconditiongroup", rootId)
            {
                ["asx_ruleaction"] = new EntityReference("asx_ruleaction", action),
                ["asx_logicaloperator"] = new OptionSetValue(All), ["asx_order"] = 1,
            });
            _rows.Add(new Entity("asx_actionconditiontest", OutcomeConversionUpdate.StableId(action + "/test/" + a))
            {
                ["asx_actionconditiongroup"] = new EntityReference("asx_actionconditiongroup", rootId),
                ["asx_outcome"] = new EntityReference("asx_conditiongroup", a), ["asx_expected"] = true, ["asx_order"] = 1,
            });

            Run();

            Assert.Equal(new[] { a, b }, Tests(rootId).Select(t => t.GetAttributeValue<EntityReference>("asx_outcome").Id));
        }

        [Fact]
        public void Stable_ids_match_the_conversion_script()
        {
            // Convert-RulesToOutcomes.ps1's StableId for this key, so trees it started are recognized.
            Assert.Equal(Guid.Parse("738bc2b9-3dfa-f3c6-f2d5-6ae8dd1b3c2f"),
                OutcomeConversionUpdate.StableId("00000000-0000-0000-0000-000000000001/root"));
            Assert.Equal(OutcomeConversionUpdate.StableId("ABC/root"), OutcomeConversionUpdate.StableId("abc/root"));
        }

        [Fact]
        public void A_second_run_has_nothing_left_and_the_update_is_no_longer_needed()
        {
            var rule = Rule();
            Group(rule, "Credit");
            Action(rule, OnMatch);
            Run();

            Assert.False(_update.IsNeeded(Service));
            var again = Run();
            Assert.True(again.Done);
            Assert.Equal(0, again.Succeeded);
        }

        [Fact]
        public void Not_needed_when_no_action_has_fire_on_set()
        {
            var rule = Rule();
            Action(rule, fireOn: null);
            _ctx.Initialize(_rows);
            Assert.False(_update.IsNeeded(Service));
        }

        [Fact]
        public void Over_budget_stops_between_rules_and_the_next_step_carries_on()
        {
            var one = Rule("One");
            Action(one, OnMatch);
            var two = Rule("Two");
            Action(two, OnMatch);

            var calls = 0;
            var first = Run(() => calls++ >= 1); // room for one rule
            Assert.False(first.Done);
            Assert.Equal(1, first.Succeeded);

            var second = _update.RunStep(new DataUpdateContext(Service, null, Guid.NewGuid()), first.Cursor, () => false);
            Assert.True(second.Done);
            Assert.Equal(1, second.Succeeded);
            Assert.False(_update.IsNeeded(Service));
        }

        [Fact]
        public void An_unknown_fire_on_value_fails_the_rule_as_an_item_and_skip_passes_over_it()
        {
            var bad = Rule("Bad");
            Action(bad, 9);
            var good = Rule("Good");
            Action(good, OnMatch);

            var e = Assert.Throws<DataUpdateItemException>(() => Run());
            Assert.Equal(bad.ToString(), e.Item);
            Assert.Contains("unknown On match / On no match value 9", e.Message);

            var cursor = _update.Skip(null, e.Item);
            var step = _update.RunStep(new DataUpdateContext(Service, null, Guid.NewGuid()), cursor, () => false);
            Assert.True(step.Done);
            Assert.Equal(cursor, step.Cursor);
        }

        [Fact]
        public void A_published_version_without_trees_fails_with_what_to_do()
        {
            var revision = Guid.NewGuid();
            var rule = Rule("Credit limit", status: 753840000, pointer: revision);
            var action = Action(rule, OnMatch);
            var snapshot = new RuleSnapshot { RuleId = rule, Rows = new List<SnapshotRow>
            {
                new SnapshotRow { Entity = "asx_rule", Id = rule, Attributes = new Dictionary<string, SnapshotValue>() },
                new SnapshotRow { Entity = "asx_ruleaction", Id = action, Attributes = new Dictionary<string, SnapshotValue>
                {
                    ["asx_rule"] = SnapshotValue.From(new EntityReference("asx_rule", rule)),
                    ["asx_isactive"] = SnapshotValue.From(true),
                } },
            } };
            _rows.Add(new Entity(PublicationSchema.Revision, revision)
            {
                ["asx_rule"] = new EntityReference("asx_rule", rule), ["asx_definition"] = snapshot.Serialize(),
            });

            var e = Assert.Throws<DataUpdateItemException>(() => Run());
            Assert.Equal(rule.ToString(), e.Item);
            Assert.Contains("published version of rule 'Credit limit'", e.Message);
            Assert.Contains("Retry failed items", e.Message);
        }

        [Fact]
        public void A_draft_is_converted_without_reading_a_published_version()
        {
            var live = Rule("Live", status: 753840000, pointer: Guid.NewGuid()); // its revision row is never read
            var draft = Rule("Live", draftOf: live);
            Group(draft, "Credit");
            var action = Action(draft, OnMatch);

            Run();

            Assert.Single(Tests(Root(action).Id));
        }

        [Fact]
        public void A_rule_published_before_published_versions_is_converted_in_place()
        {
            // Every rule from 0.0.0.1: Published, no revision, enforced from its own rows.
            var rule = Rule("Legacy", status: 753840000);
            Group(rule, "Credit");
            var action = Action(rule, OnNoMatch);

            Run();

            Assert.Equal(Any, Root(action).GetAttributeValue<OptionSetValue>("asx_logicaloperator").Value);
        }
    }
}
