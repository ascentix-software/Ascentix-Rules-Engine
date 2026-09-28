using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>One record a Rule Run could not evaluate or that a fired Block skipped: recorded
    /// against asx_failures so a run reports what went wrong without failing the whole run.</summary>
    public sealed class RunFailure
    {
        public RunFailure(Guid recordId, string kind, string message)
        {
            RecordId = recordId;
            Kind = kind;
            Message = message;
        }

        public Guid RecordId { get; }
        public string Kind { get; }       // "Blocked" or "Failed"
        public string Message { get; }
    }

    /// <summary>Where a Rule Run's next page picks up: <see cref="Index"/> for a given-records run,
    /// <see cref="Page"/>/<see cref="Cookie"/>/<see cref="Offset"/> for an all-records run. An empty
    /// bookmark starts at page 1. <see cref="Skip"/> lists record ids already accounted for.</summary>
    public class RunBookmark
    {
        public int Index { get; set; }
        public int Page { get; set; } = 1;
        public string Cookie { get; set; }
        public int Offset { get; set; }
        public List<Guid> Skip { get; set; } = new List<Guid>();
    }

    /// <summary>JSON helpers for the asx_rulerun state columns (asx_recordids, asx_failures,
    /// asx_bookmark, asx_ruleversions), using DataContractJsonSerializer like the engine's other
    /// serializers (see <see cref="RunRulesResultSerializer"/>).</summary>
    public static class RunState
    {
        public const int MaxRecordIds = 250;
        public const int MaxFailures = 50;

        private const string RecordIdsErrorMessage = "Record ids must be a JSON array of record ids.";

        [DataContract]
        private class FailureDto
        {
            [DataMember(Name = "recordId", Order = 1)] public string RecordId { get; set; }
            [DataMember(Name = "kind", Order = 2)] public string Kind { get; set; }
            [DataMember(Name = "message", Order = 3)] public string Message { get; set; }
        }

        [DataContract]
        private class BookmarkDto
        {
            [DataMember(Name = "index", Order = 1)] public int Index { get; set; }
            [DataMember(Name = "page", Order = 2)] public int Page { get; set; }
            [DataMember(Name = "cookie", Order = 3)] public string Cookie { get; set; }
            [DataMember(Name = "offset", Order = 4)] public int Offset { get; set; }
            [DataMember(Name = "skip", Order = 5)] public List<string> Skip { get; set; }
        }

        public static List<Guid> ParseRecordIds(string json)
        {
            var ids = ParseGuidArray(json, RecordIdsErrorMessage);
            var seen = new HashSet<Guid>();
            var result = new List<Guid>();
            foreach (var id in ids)
                if (seen.Add(id)) result.Add(id);
            return result;
        }

        public static string WriteRecordIds(IEnumerable<Guid> ids) => WriteGuidArray(ids);

        public static List<RunFailure> ParseFailures(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new List<RunFailure>();
            try
            {
                using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                {
                    var dtos = (List<FailureDto>)new DataContractJsonSerializer(typeof(List<FailureDto>)).ReadObject(stream);
                    return dtos.Select(d => new RunFailure(Guid.Parse(d.RecordId), d.Kind, d.Message)).ToList();
                }
            }
            catch (Exception e) when (!(e is InvalidPluginExecutionException))
            {
                throw new InvalidPluginExecutionException("Run failures are not valid JSON.", e);
            }
        }

        public static string WriteFailures(IEnumerable<RunFailure> failures)
        {
            var dtos = (failures ?? Enumerable.Empty<RunFailure>())
                .Take(MaxFailures)
                .Select(f => new FailureDto { RecordId = f.RecordId.ToString(), Kind = f.Kind, Message = f.Message })
                .ToList();
            using (var ms = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(List<FailureDto>)).WriteObject(ms, dtos);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        public static RunBookmark ParseBookmark(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new RunBookmark();
            try
            {
                using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                {
                    var dto = (BookmarkDto)new DataContractJsonSerializer(typeof(BookmarkDto)).ReadObject(stream);
                    return new RunBookmark
                    {
                        Index = dto.Index,
                        Page = dto.Page,
                        Cookie = dto.Cookie,
                        Offset = dto.Offset,
                        Skip = (dto.Skip ?? new List<string>()).Select(Guid.Parse).ToList()
                    };
                }
            }
            catch (Exception e) when (!(e is InvalidPluginExecutionException))
            {
                throw new InvalidPluginExecutionException("Run bookmark is not valid JSON.", e);
            }
        }

        public static string WriteBookmark(RunBookmark bookmark)
        {
            var dto = new BookmarkDto
            {
                Index = bookmark.Index,
                Page = bookmark.Page,
                Cookie = bookmark.Cookie,
                Offset = bookmark.Offset,
                Skip = (bookmark.Skip ?? new List<Guid>()).Select(g => g.ToString()).ToList()
            };
            using (var ms = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(BookmarkDto)).WriteObject(ms, dto);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        public static List<Guid> ParseVersions(string json) => ParseGuidArray(json, "Rule versions must be a JSON array of rule ids.");

        public static string WriteVersions(IEnumerable<Guid> versions) => WriteGuidArray(versions);

        private static List<Guid> ParseGuidArray(string json, string errorMessage)
        {
            if (string.IsNullOrWhiteSpace(json)) return new List<Guid>();
            try
            {
                using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                {
                    var raw = (List<string>)new DataContractJsonSerializer(typeof(List<string>)).ReadObject(stream);
                    var result = new List<Guid>();
                    foreach (var s in raw)
                    {
                        if (!Guid.TryParse(s, out var id))
                            throw new InvalidPluginExecutionException(errorMessage);
                        result.Add(id);
                    }
                    return result;
                }
            }
            catch (Exception e) when (!(e is InvalidPluginExecutionException))
            {
                throw new InvalidPluginExecutionException(errorMessage, e);
            }
        }

        private static string WriteGuidArray(IEnumerable<Guid> ids)
        {
            var list = (ids ?? Enumerable.Empty<Guid>()).Select(g => g.ToString()).ToList();
            using (var ms = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(List<string>)).WriteObject(ms, list);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }
    }
}
