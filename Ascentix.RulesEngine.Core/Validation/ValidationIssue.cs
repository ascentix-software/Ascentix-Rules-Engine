using System;
using System.Collections.Generic;
using System.Linq;

namespace Ascentix.RulesEngine.Core.Validation
{
    public enum IssueSeverity { Error, Warning }

    public enum TargetKind { Rule, Group, Condition, Action }

    /// <summary>Points an issue at the node the editor should highlight.</summary>
    public class IssueTarget
    {
        public TargetKind Kind { get; set; }
        public Guid Id { get; set; }
        public string Field { get; set; } // optional: the specific field within the node

        public static IssueTarget Rule(Guid id) => new IssueTarget { Kind = TargetKind.Rule, Id = id };
        public static IssueTarget Group(Guid id) => new IssueTarget { Kind = TargetKind.Group, Id = id };
        public static IssueTarget Condition(Guid id, string field = null) => new IssueTarget { Kind = TargetKind.Condition, Id = id, Field = field };
        public static IssueTarget Action(Guid id, string field = null) => new IssueTarget { Kind = TargetKind.Action, Id = id, Field = field };
    }

    public class ValidationIssue
    {
        public IssueSeverity Severity { get; set; }
        public string Code { get; set; }
        public string Message { get; set; }
        public IssueTarget Target { get; set; }

        public static ValidationIssue Error(string code, string message, IssueTarget target)
            => new ValidationIssue { Severity = IssueSeverity.Error, Code = code, Message = message, Target = target };

        public static ValidationIssue Warning(string code, string message, IssueTarget target)
            => new ValidationIssue { Severity = IssueSeverity.Warning, Code = code, Message = message, Target = target };
    }

    public class ValidationReport
    {
        public IReadOnlyList<ValidationIssue> Issues { get; private set; }
        public bool IsValid { get; private set; }

        public static ValidationReport From(IEnumerable<ValidationIssue> issues)
        {
            var list = (issues ?? Enumerable.Empty<ValidationIssue>()).ToList();
            return new ValidationReport
            {
                Issues = list,
                IsValid = !list.Any(i => i.Severity == IssueSeverity.Error)
            };
        }
    }
}
