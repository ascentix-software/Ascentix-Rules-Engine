using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>Everything the RuleValidator needs about one rule, assembled by RuleValidationLoader.</summary>
    public class RuleForValidation
    {
        private IReadOnlyList<ConditionGroup> _groups = new List<ConditionGroup>();
        private IReadOnlyList<RuleAction> _actions = new List<RuleAction>();
        private RuleReferences _references;

        public Guid RuleId { get; set; }
        public Entity RuleEntity { get; set; }
        public string PrimaryTable { get; set; }
        public IReadOnlyList<ConditionGroup> Groups
        {
            get => _groups;
            set { _groups = value ?? new List<ConditionGroup>(); _references = null; }
        }
        /// <summary>The rule's config forest as loaded, UNVALIDATED (<see cref="TableConfigTree.FromNodesUnvalidated"/>):
        /// the validator's job is to report a broken shape (cycle, missing parent, no root) as an
        /// issue, so every query it runs on this tree answers conservatively instead of throwing.</summary>
        public TableConfigTree Configs { get; set; } = TableConfigTree.Empty;
        public IReadOnlyList<RuleAction> Actions
        {
            get => _actions;
            set { _actions = value ?? new List<RuleAction>(); _references = null; }
        }
        public IReadOnlyList<string> TriggerColumns { get; set; } = new List<string>();

        /// <summary>The rule's reference set (<see cref="RuleReferences"/>) over <see cref="Groups"/>
        /// and <see cref="Actions"/>. Set by the loader; computed on first read otherwise.</summary>
        public RuleReferences References
        {
            get => _references ?? (_references = RuleReferences.Compute(_groups, _actions));
            set => _references = value;
        }

        /// <summary>Every group, flattened depth-first (roots + all nested child groups).</summary>
        public IEnumerable<ConditionGroup> AllGroups()
        {
            foreach (var root in Groups)
                foreach (var g in Flatten(root))
                    yield return g;
        }

        public IEnumerable<RuleCondition> AllConditions()
            => AllGroups().SelectMany(g => g.Conditions ?? new List<RuleCondition>());

        private static IEnumerable<ConditionGroup> Flatten(ConditionGroup g)
        {
            yield return g;
            foreach (var child in g.ChildGroups ?? new List<ConditionGroup>())
                foreach (var d in Flatten(child))
                    yield return d;
        }
    }
}
