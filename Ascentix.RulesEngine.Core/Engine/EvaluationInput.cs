using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Everything one context bucket's evaluation needs, gathered from Dataverse by
    /// <see cref="EvaluationGatherer"/> and consumed by <see cref="BucketEvaluator"/> without
    /// touching a service again. One instance per bucket; one <see cref="EvaluationRecord"/>
    /// (root + its own seeded result cache) per input record. Immutable once built.
    ///
    /// Deliberately NOT carried: the in-flight batch, the query plan, the root-column set, the
    /// build mode, the channel and the root table name. Those are fetch-time facts already
    /// spent by the time the caches are seeded.
    /// </summary>
    public sealed class EvaluationInput
    {
        /// <summary>One root record with the rows fetched for it. The cache is the record's
        /// own: every root node of <see cref="EvaluationInput.Tree"/> is already seeded.</summary>
        public sealed class EvaluationRecord
        {
            public EvaluationRecord(int index, Entity root, QueryResultCache cache)
            {
                Index = index;
                Root = root;
                Cache = cache ?? throw new ArgumentNullException(nameof(cache));
            }

            /// <summary>Position in the run's input list: where the verdict lands.</summary>
            public int Index { get; }
            public Entity Root { get; }
            public QueryResultCache Cache { get; }
        }

        public EvaluationInput(
            IReadOnlyList<Guid> ruleIds,
            IReadOnlyList<ConditionGroup> rootGroups,
            IReadOnlyDictionary<Guid, List<RuleAction>> actionsByRule,
            IReadOnlyDictionary<Guid, List<FieldMappingEntry>> mappingsByAction,
            TableConfigTree tree,
            PushdownPlan pushdown,
            IReadOnlyList<EvaluationRecord> records,
            int languageId,
            RuleEvaluationContext context,
            DateTime utcNow,
            IAttributeMetadataProvider metadata,
            IOptionLabelProvider labels,
            RuleTrigger trigger)
        {
            RuleIds = ruleIds ?? throw new ArgumentNullException(nameof(ruleIds));
            RootGroups = rootGroups ?? throw new ArgumentNullException(nameof(rootGroups));
            ActionsByRule = actionsByRule ?? throw new ArgumentNullException(nameof(actionsByRule));
            MappingsByAction = mappingsByAction ?? throw new ArgumentNullException(nameof(mappingsByAction));
            Tree = tree ?? TableConfigTree.Empty;
            Pushdown = pushdown;
            Records = records ?? throw new ArgumentNullException(nameof(records));
            LanguageId = languageId;
            Context = context;
            UtcNow = utcNow;
            Metadata = metadata;
            Labels = labels;
            Trigger = trigger;
        }

        /// <summary>Rule ids in loader order, the order rules evaluate in.</summary>
        public IReadOnlyList<Guid> RuleIds { get; }

        /// <summary>Every mapped root condition group of the bucket (all rules).</summary>
        public IReadOnlyList<ConditionGroup> RootGroups { get; }

        public IReadOnlyDictionary<Guid, List<RuleAction>> ActionsByRule { get; }

        /// <summary>The gather stage's parsed-mapping memo (action id → entries), as the
        /// reference computation left it. An action absent here either has no mapping or one
        /// that did not parse; the evaluator parses on demand so the fault still surfaces only
        /// when that action fires.</summary>
        public IReadOnlyDictionary<Guid, List<FieldMappingEntry>> MappingsByAction { get; }

        public TableConfigTree Tree { get; }

        /// <summary>Which cache variant each condition reads (<see cref="PushdownPlan.ConditionVariantKeys"/>).
        /// Null keeps every read on the unfiltered entries.</summary>
        public PushdownPlan Pushdown { get; }

        public IReadOnlyList<EvaluationRecord> Records { get; }

        public int LanguageId { get; }

        /// <summary>The bucket's evaluation context: what a write intent is stamped with.</summary>
        public RuleEvaluationContext Context { get; }

        /// <summary>The evaluation instant (date expressions, relative dates). Distinct from the
        /// schedule-filter instant taken when rules were loaded.</summary>
        public DateTime UtcNow { get; }

        /// <summary>Column-type and option-label resolution. Constructed by the gather stage;
        /// may be a lazy, service-backed provider. The evaluator only sees the interface.</summary>
        public IAttributeMetadataProvider Metadata { get; }

        public IOptionLabelProvider Labels { get; }

        /// <summary>Provenance: which trigger gathered this input.</summary>
        public RuleTrigger Trigger { get; }
    }
}
