using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ValidationReportTests
    {
        [Fact]
        public void Report_with_no_errors_is_valid()
        {
            var report = ValidationReport.From(new List<ValidationIssue>());
            Assert.True(report.IsValid);
            Assert.Empty(report.Issues);
        }

        [Fact]
        public void Report_with_an_error_is_invalid()
        {
            var id = Guid.NewGuid();
            var report = ValidationReport.From(new[]
            {
                ValidationIssue.Error("STRUCT_NO_ACTIONS", "Rule has no actions.", IssueTarget.Rule(id))
            });
            Assert.False(report.IsValid);
            Assert.Equal(TargetKind.Rule, report.Issues[0].Target.Kind);
            Assert.Equal(id, report.Issues[0].Target.Id);
        }

        [Fact]
        public void Report_with_only_warnings_is_valid()
        {
            var report = ValidationReport.From(new[]
            {
                ValidationIssue.Warning("SEM_UNREACHABLE", "Advisory.", IssueTarget.Condition(Guid.NewGuid()))
            });
            Assert.True(report.IsValid);
        }
    }
}
