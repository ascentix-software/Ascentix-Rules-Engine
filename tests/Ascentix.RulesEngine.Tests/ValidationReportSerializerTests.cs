using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ValidationReportSerializerTests
    {
        [Fact]
        public void Serializes_issue_with_target()
        {
            var id = Guid.NewGuid();
            var report = ValidationReport.From(new[]
            {
                ValidationIssue.Error("STRUCT_NO_ACTIONS", "Rule has no actions.", IssueTarget.Rule(id))
            });
            var json = ValidationReportSerializer.Serialize(report);
            Assert.Contains("\"isValid\":false", json);
            Assert.Contains("STRUCT_NO_ACTIONS", json);
            Assert.Contains(id.ToString(), json);
            Assert.Contains("Rule", json); // target kind name
        }

        [Fact]
        public void Valid_report_serializes_empty_issue_array()
        {
            var json = ValidationReportSerializer.Serialize(ValidationReport.From(new List<ValidationIssue>()));
            Assert.Contains("\"isValid\":true", json);
            Assert.Contains("\"issues\":[]", json);
        }

        [Fact]
        public void JoinErrors_joins_only_error_messages()
        {
            var report = ValidationReport.From(new[]
            {
                ValidationIssue.Error("A", "first", IssueTarget.Rule(Guid.NewGuid())),
                ValidationIssue.Warning("B", "ignored", IssueTarget.Rule(Guid.NewGuid())),
                ValidationIssue.Error("C", "second", IssueTarget.Rule(Guid.NewGuid())),
            });
            var text = ValidationReportSerializer.JoinErrors(report);
            Assert.Contains("first", text);
            Assert.Contains("second", text);
            Assert.DoesNotContain("ignored", text);
        }
    }
}
