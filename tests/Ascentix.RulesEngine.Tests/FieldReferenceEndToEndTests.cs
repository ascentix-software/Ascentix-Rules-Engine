using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class FieldReferenceEndToEndTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // Root rule on "account": creditlimit >= revenue (same-record field reference).
        private static List<Entity> Seed(Guid rootCfgId, Guid ruleId, Guid grpId, Guid condId)
        {
            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "creditlimit",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.GreaterThanOrEqual),
                    [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.FieldReference),
                    [Q(SchemaNames.RuleCondition.ComparisonValueColumn)] = "revenue",
                },
            };
        }

        private static bool Matches(XrmFakedContext ctx, Entity root)
        {
            var service = ctx.GetOrganizationService();
            var rules = new RuleLoader(service).LoadRules("account");
            var mapper = new ConditionGroupMapper();
            var rootGroups = mapper.MapConditionGroups(rules);
            var flat = rootGroups.SelectMany(g => g.Conditions).ToList();
            var configs = new TableConfigLoader(service).LoadConfigs(
                RuleReferences.Compute(rootGroups, null).NodesToLoad.Cast<object>().ToArray());
            var plan = QueryExecutionPlan.Build(configs, flat);
            var cache = new QueryResultCache();
            new QueryExecutor(service, cache, configs).Execute(root, plan);
            var evaluator = new ConditionGroupEvaluator(new ConditionEvaluator(cache, configs, new FieldValueResolver()));
            return rootGroups.Where(g => g.RuleId == rules[0].Id).All(g => evaluator.EvaluateGroup(g).Passed);
        }

        [Fact]
        public void Field_ref_passes_when_lhs_meets_rhs()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid()));
            var root = new Entity("account", Guid.NewGuid()) { ["creditlimit"] = 1000, ["revenue"] = 500 };
            Assert.True(Matches(ctx, root));   // 1000 >= 500
        }

        [Fact]
        public void Field_ref_fails_when_lhs_below_rhs()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid()));
            var root = new Entity("account", Guid.NewGuid()) { ["creditlimit"] = 100, ["revenue"] = 500 };
            Assert.False(Matches(ctx, root));  // 100 >= 500 is false
        }
    }
}
