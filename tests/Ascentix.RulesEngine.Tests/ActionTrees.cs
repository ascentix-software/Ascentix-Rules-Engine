using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>"Fires when" trees for model-level tests: Always (an empty ALL root), AllTrue (an ALL root
    /// with "is true" tests on the given outcomes) and AnyFalse (an ANY root with "is false" tests).</summary>
    internal static class ActionTrees
    {
        public static ActionConditionGroup Always() => ActionConditionGroup.Always();
        public static ActionConditionGroup AllTrue(params Guid[] outcomes) => Root(LogicalOperator.And, true, outcomes);
        public static ActionConditionGroup AnyFalse(params Guid[] outcomes) => Root(LogicalOperator.Or, false, outcomes);

        private static ActionConditionGroup Root(LogicalOperator op, bool expected, Guid[] outcomes) => new ActionConditionGroup
        {
            Id = Guid.NewGuid(),
            LogicalOperator = op,
            Tests = outcomes.Select((o, i) => new ActionConditionTest { Id = Guid.NewGuid(), OutcomeId = o, Expected = expected, Order = i + 1 }).ToList(),
        };
    }

    /// <summary>The same trees as Dataverse rows for FakeXrmEasy seeds.</summary>
    internal static class ActionTreeRows
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        public static List<Entity> Always(Guid actionId) => Root(actionId, LogicalOperator.And, true);
        public static List<Entity> AllTrue(Guid actionId, params Guid[] outcomes) => Root(actionId, LogicalOperator.And, true, outcomes);
        public static List<Entity> AnyFalse(Guid actionId, params Guid[] outcomes) => Root(actionId, LogicalOperator.Or, false, outcomes);

        private static List<Entity> Root(Guid actionId, LogicalOperator op, bool expected, params Guid[] outcomes)
        {
            var group = new Entity(Q(SchemaNames.ActionConditionGroup.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.ActionConditionGroup.RuleAction)] = new EntityReference(Q(SchemaNames.RuleAction.Entity), actionId),
                [Q(SchemaNames.ActionConditionGroup.LogicalOperator)] = new OptionSetValue((int)op),
                [Q(SchemaNames.ActionConditionGroup.Order)] = 1,
            };
            var rows = new List<Entity> { group };
            rows.AddRange(outcomes.Select((o, i) => new Entity(Q(SchemaNames.ActionConditionTest.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.ActionConditionTest.Group)] = group.ToEntityReference(),
                [Q(SchemaNames.ActionConditionTest.Outcome)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), o),
                [Q(SchemaNames.ActionConditionTest.Expected)] = expected,
                [Q(SchemaNames.ActionConditionTest.Order)] = i + 1,
            }));
            return rows;
        }
    }
}
