using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>
    /// Authoring-time pushdown advisory (TRAV_PUSHDOWN). Non-blocking: for each
    /// condition whose node filters / search criteria cannot be fully applied server-side, a
    /// warning states the runtime consequence: if more rows survive server filtering than the
    /// traversal cap, saves fail at runtime. Authors targeting big tables learn at publish
    /// time, not in production. Mirrors PushdownPlanner's translation (self-targeting filters +
    /// search criteria, substring operators refused pending per-column metadata) so the warning
    /// and the runtime agree about what pushes.
    /// </summary>
    public static class PushdownChecks
    {
        public const string CodePushdownResidual = "TRAV_PUSHDOWN";

        public static IReadOnlyList<ValidationIssue> Check(RuleForValidation model)
        {
            var issues = new List<ValidationIssue>();
            if (model == null) return issues;

            var translator = new PushdownTranslator(pushSubstringOperators: false);

            foreach (var group in model.AllGroups())
            {
                foreach (var condition in group.Conditions ?? new List<RuleCondition>())
                {
                    var selfFilters = (group.NodeFilterGroups ?? new List<NodeFilterGroup>())
                        .Where(f => (f.RuleConditionId == null || f.RuleConditionId == condition.Id) &&
                                    f.TableConfigNodeId == condition.TableConfigNodeId)
                        .ToList();
                    var searchGroups = condition.SearchCriteriaGroups ?? new List<SearchCriteriaGroup>();
                    if (selfFilters.Count == 0 && searchGroups.Count == 0) continue;

                    var combined = new NodeFilterGroup { LogicalOperator = LogicalOperator.And };
                    combined.ChildGroups.AddRange(selfFilters);
                    foreach (var sg in searchGroups)
                        combined.ChildGroups.Add(ConvertSearchGroup(sg));

                    var translated = translator.Translate(combined);
                    if (!translated.HasResidual) continue;

                    var table = model.Configs != null &&
                                model.Configs.TryGetNode(condition.TableConfigNodeId, out var node)
                        ? node.TableLogicalName
                        : condition.TableConfigNodeId.ToString();

                    issues.Add(ValidationIssue.Warning(
                        CodePushdownResidual,
                        $"Some criteria on node '{table}' cannot be applied server-side and will " +
                        $"filter in memory. If more than {QueryExecutor.MaxReturnedRowsPerVariant:N0} " +
                        "rows survive server-side filtering, saves on this rule's table will fail " +
                        "at runtime. Prefer literal comparison criteria (eq/ne/gt/ge/lt/le/" +
                        "null/not-null) on large collections; see Beta Limitations.",
                        IssueTarget.Condition(condition.Id)));
                }
            }

            return issues;
        }

        private static NodeFilterGroup ConvertSearchGroup(SearchCriteriaGroup sg)
        {
            var g = new NodeFilterGroup { LogicalOperator = sg.LogicalOperator };
            foreach (var c in sg.Criteria ?? new List<SearchCriterion>())
                g.Criteria.Add(new NodeFilterCriterion
                {
                    Kind = CriterionKind.Comparison,
                    FieldName = c.FieldName,
                    Operator = c.Operator,
                    Value = c.Value,
                    ValueSource = ComparisonValueSource.Literal,
                });
            foreach (var child in sg.ChildGroups ?? new List<SearchCriteriaGroup>())
                g.ChildGroups.Add(ConvertSearchGroup(child));
            return g;
        }
    }
}
