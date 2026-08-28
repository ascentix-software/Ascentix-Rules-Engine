using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>Serializes a ValidationReport to the asx_ValidateRule Issues JSON. Sandbox-safe.</summary>
    public static class ValidationReportSerializer
    {
        [DataContract]
        private class TargetDto
        {
            [DataMember(Name = "kind", Order = 1)] public string Kind { get; set; }
            [DataMember(Name = "id", Order = 2)] public string Id { get; set; }
            [DataMember(Name = "field", Order = 3, EmitDefaultValue = false)] public string Field { get; set; }
        }

        [DataContract]
        private class IssueDto
        {
            [DataMember(Name = "severity", Order = 1)] public string Severity { get; set; }
            [DataMember(Name = "code", Order = 2)] public string Code { get; set; }
            [DataMember(Name = "message", Order = 3)] public string Message { get; set; }
            [DataMember(Name = "target", Order = 4)] public TargetDto Target { get; set; }
        }

        [DataContract]
        private class ReportDto
        {
            [DataMember(Name = "isValid", Order = 1)] public bool IsValid { get; set; }
            [DataMember(Name = "issues", Order = 2)] public List<IssueDto> Issues { get; set; }
        }

        public static string Serialize(ValidationReport report)
        {
            var dto = new ReportDto
            {
                IsValid = report.IsValid,
                Issues = report.Issues.Select(i => new IssueDto
                {
                    Severity = i.Severity.ToString(),
                    Code = i.Code,
                    Message = i.Message,
                    Target = new TargetDto
                    {
                        Kind = i.Target.Kind.ToString(),
                        Id = i.Target.Id.ToString(),
                        Field = i.Target.Field
                    }
                }).ToList()
            };

            var serializer = new DataContractJsonSerializer(typeof(ReportDto));
            using (var ms = new MemoryStream())
            {
                serializer.WriteObject(ms, dto);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        public static string JoinErrors(ValidationReport report)
            => string.Join("\n", report.Issues
                .Where(i => i.Severity == IssueSeverity.Error)
                .Select(i => i.Message));
    }
}
