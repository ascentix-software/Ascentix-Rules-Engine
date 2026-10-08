using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    // asx_RunRules' DraftRuleId: the draft's authored rows run in place of the live rule it is a
    // draft of, so Preview on a record can show what publishing the draft would do.
    public class RunRulesDraftPreviewTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // An On demand account rule: Block "<message>" unless name equals "<valid>".
        private static List<Entity> Rule(Guid ruleId, RuleStatus status, string valid, string message, Guid? draftOf = null)
        {
            var ids = (cfg: Guid.NewGuid(), grp: Guid.NewGuid(), cond: Guid.NewGuid(), act: Guid.NewGuid());
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)status),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
            };
            if (draftOf != null) rule[PublicationSchema.DraftOf] = new EntityReference(Q(SchemaNames.Rule.Entity), draftOf.Value);
            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), ids.cfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                rule,
                new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
                {
                    [Q(SchemaNames.PrimaryName)] = "Name is " + valid,
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = valid,
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                    [Q(SchemaNames.RuleAction.Message)] = message,
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
                ActionTreeRows.AnyFalse(ids.act, ids.grp),
            };
        }

        private static XrmFakedPluginExecutionContext Run(XrmFakedContext ctx, string name, Guid? draft)
        {
            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"" + name + "\"}" },
                { "Triggers", "OnDemand" },
            };
            if (draft != null) input.Add("DraftRuleId", draft.Value);
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_RunRules", Stage = 30, InputParameters = input, OutputParameters = new ParameterCollection(),
            };
            ctx.ExecutePluginWith<RunRulesApi>(pctx);
            return pctx;
        }

        [Fact]
        public void A_draft_runs_in_place_of_its_live_rule()
        {
            var live = Guid.NewGuid();
            var draft = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            var rows = Rule(live, RuleStatus.Published, "Live", "Live says no");
            rows.AddRange(Rule(draft, RuleStatus.Draft, "Draft", "Draft says no", draftOf: live));
            ctx.Initialize(rows);

            // "Live" passes the live rule but fails the draft.
            var withoutDraft = Run(ctx, "Live", null);
            Assert.True((bool)withoutDraft.OutputParameters["IsValid"]);

            var withDraft = Run(ctx, "Live", draft);
            Assert.False((bool)withDraft.OutputParameters["IsValid"]);
            var results = (string)withDraft.OutputParameters["Results"];
            Assert.Contains("Draft says no", results);
            Assert.DoesNotContain("Live says no", results);
            Assert.Contains(draft.ToString(), results);
        }

        [Fact]
        public void A_never_published_rule_can_be_previewed()
        {
            var draft = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(Rule(draft, RuleStatus.Draft, "Draft", "Draft says no"));

            Assert.True((bool)Run(ctx, "Other", null).OutputParameters["IsValid"]); // drafts never run on their own
            var preview = Run(ctx, "Other", draft);
            Assert.False((bool)preview.OutputParameters["IsValid"]);
            Assert.Contains("Draft says no", (string)preview.OutputParameters["Results"]);
        }

        [Fact]
        public void A_draft_on_another_table_is_rejected()
        {
            var draft = Guid.NewGuid();
            var rows = Rule(draft, RuleStatus.Draft, "Draft", "Draft says no");
            rows[1][Q(SchemaNames.Rule.TableLogicalName)] = "contact";
            var ctx = new XrmFakedContext();
            ctx.Initialize(rows);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Run(ctx, "x", draft));
            Assert.Contains("not on the account table", ex.Message);
        }

        [Fact]
        public void A_DraftRuleId_that_is_not_a_guid_is_rejected()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Rule(Guid.NewGuid(), RuleStatus.Published, "Live", "Live says no"));
            var input = new ParameterCollection
            {
                { "TableName", "account" }, { "RecordJson", "{\"name\":\"x\"}" }, { "DraftRuleId", "nope" },
            };
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_RunRules", Stage = 30, InputParameters = input, OutputParameters = new ParameterCollection(),
            };
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RunRulesApi>(pctx));
            Assert.Contains("DraftRuleId", ex.Message);
        }
    }
}
