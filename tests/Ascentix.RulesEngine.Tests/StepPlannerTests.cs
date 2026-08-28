using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin.Registration;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class StepPlannerTests
    {
        [Fact]
        public void No_steps_when_no_rule_has_a_server_action()
        {
            var analyses = new[]
            {
                new RuleAnalysis { HasServerAction = false, OnUpdate = true, IsRootOnly = true,
                                   RootColumns = new HashSet<string> { "name" } },
            };
            var d = StepPlanner.Plan(analyses);
            Assert.False(d.Create); Assert.False(d.Update); Assert.False(d.Delete);
        }

        [Fact]
        public void Update_filtering_attributes_are_union_when_all_update_rules_are_root_only()
        {
            var analyses = new[]
            {
                new RuleAnalysis { HasServerAction = true, OnUpdate = true, IsRootOnly = true,
                                   RootColumns = new HashSet<string> { "name" } },
                new RuleAnalysis { HasServerAction = true, OnUpdate = true, IsRootOnly = true,
                                   RootColumns = new HashSet<string> { "statuscode" } },
            };
            var d = StepPlanner.Plan(analyses);
            Assert.True(d.Update);
            Assert.Equal(new[] { "name", "statuscode" },
                d.UpdateFilteringAttributes.OrderBy(s => s).ToArray());
        }

        [Fact]
        public void Update_fires_always_when_any_server_update_rule_traverses()
        {
            var analyses = new[]
            {
                new RuleAnalysis { HasServerAction = true, OnUpdate = true, IsRootOnly = true,
                                   RootColumns = new HashSet<string> { "name" } },
                new RuleAnalysis { HasServerAction = true, OnUpdate = true, IsRootOnly = false,
                                   RootColumns = new HashSet<string> { "primarycontactid" } }, // traversal
            };
            var d = StepPlanner.Plan(analyses);
            Assert.True(d.Update);
            Assert.Null(d.UpdateFilteringAttributes); // null => fire on all columns
        }

        [Fact]
        public void Create_and_delete_track_server_relevant_rules_for_those_triggers()
        {
            var analyses = new[]
            {
                new RuleAnalysis { HasServerAction = true, OnCreate = true, IsRootOnly = true,
                                   RootColumns = new HashSet<string>() },
                new RuleAnalysis { HasServerAction = true, OnDelete = true, IsRootOnly = true,
                                   RootColumns = new HashSet<string>() },
            };
            var d = StepPlanner.Plan(analyses);
            Assert.True(d.Create); Assert.True(d.Delete); Assert.False(d.Update);
        }
    }
}
