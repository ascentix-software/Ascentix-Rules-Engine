using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Plugin.DataUpdates
{
    /// <summary>asx_dataupdate.asx_status. Values are stored; never renumber.</summary>
    public enum DataUpdateState
    {
        Running = 1,
        Completed = 2,
        CompletedWithFailures = 3,
        Failed = 4,
    }

    public sealed class DataUpdateFailure
    {
        public DataUpdateFailure(string item, string message)
        {
            Item = item;
            Message = message;
        }

        public string Item { get; }
        public string Message { get; }
    }

    public sealed class DataUpdateRef
    {
        public DataUpdateRef(int number, string title)
        {
            Number = number;
            Title = title;
        }

        public int Number { get; }
        public string Title { get; }
    }

    /// <summary>One asx_dataupdate row's state.</summary>
    public sealed class DataUpdateRow
    {
        public DataUpdateRow(int number, string title)
        {
            Number = number;
            Title = title;
        }

        public int Number { get; }
        public string Title { get; }
        public DataUpdateState State { get; set; }
        public string Cursor { get; set; }
        public int Succeeded { get; set; }
        public int Failed { get; set; }
        /// <summary>Every failure recorded; only the first MaxFailures are stored.</summary>
        public List<DataUpdateFailure> Failures { get; } = new List<DataUpdateFailure>();
        public DateTime? StartedOn { get; set; }
        public DateTime? CompletedOn { get; set; }
        public DateTime? LastPageOn { get; set; }
        public Guid? RunBy { get; set; }
    }

    /// <summary>Reads and writes asx_dataupdate rows (docs/Schema.md §2.18) and their JSON.</summary>
    public static class DataUpdateRows
    {
        public const int MaxFailures = 50;

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        public static string Entity => Q(SchemaNames.DataUpdate.Entity);

        /// <summary>The fixed row id of update <paramref name="number"/>: one row per number, no alternate key needed.</summary>
        public static Guid RowId(int number) => new Guid($"a5d0a7e0-0000-4000-8000-{number:D12}");

        /// <summary>An update is pending when it has no row, or its row is Running or Failed.</summary>
        public static bool IsPending(DataUpdateRow row) =>
            row == null || row.State == DataUpdateState.Running || row.State == DataUpdateState.Failed;

        public static Dictionary<int, DataUpdateRow> Load(IOrganizationService system)
        {
            var rows = system.RetrieveMultiple(new QueryExpression(Entity) { ColumnSet = new ColumnSet(true) }).Entities;
            var byNumber = new Dictionary<int, DataUpdateRow>();
            foreach (var row in rows.Select(FromEntity))
                if (!byNumber.ContainsKey(row.Number)) byNumber[row.Number] = row;
            return byNumber;
        }

        public static DataUpdateRow LoadOne(IOrganizationService system, int number) =>
            FromEntity(system.Retrieve(Entity, RowId(number), new ColumnSet(true)));

        /// <summary>Writes the row's last-page time. Taking the row lock this way holds it until the call's transaction ends.</summary>
        public static void Touch(IOrganizationService system, int number, DateTime now) =>
            system.Update(new Entity(Entity, RowId(number)) { [Q(SchemaNames.DataUpdate.LastPageOn)] = now });

        public static void Create(IOrganizationService system, DataUpdateRow row)
        {
            var entity = ToEntity(row);
            entity[Q(SchemaNames.DataUpdate.Number)] = row.Number;
            entity[Q(SchemaNames.DataUpdate.Name)] = row.Title;
            system.Create(entity);
        }

        public static void Save(IOrganizationService system, DataUpdateRow row) => system.Update(ToEntity(row));

        private static Entity ToEntity(DataUpdateRow row) => new Entity(Entity, RowId(row.Number))
        {
            [Q(SchemaNames.DataUpdate.Status)] = new OptionSetValue((int)row.State),
            [Q(SchemaNames.DataUpdate.Cursor)] = row.Cursor,
            [Q(SchemaNames.DataUpdate.Succeeded)] = row.Succeeded,
            [Q(SchemaNames.DataUpdate.Failed)] = row.Failed,
            [Q(SchemaNames.DataUpdate.Failures)] = WriteFailures(row.Failures),
            [Q(SchemaNames.DataUpdate.StartedOn)] = row.StartedOn,
            [Q(SchemaNames.DataUpdate.CompletedOn)] = row.CompletedOn,
            [Q(SchemaNames.DataUpdate.LastPageOn)] = row.LastPageOn,
            [Q(SchemaNames.DataUpdate.RunBy)] = row.RunBy.HasValue ? new EntityReference("systemuser", row.RunBy.Value) : null,
        };

        private static DataUpdateRow FromEntity(Entity entity)
        {
            var row = new DataUpdateRow(entity.GetAttributeValue<int>(Q(SchemaNames.DataUpdate.Number)),
                entity.GetAttributeValue<string>(Q(SchemaNames.DataUpdate.Name)))
            {
                State = (DataUpdateState)(entity.GetAttributeValue<OptionSetValue>(Q(SchemaNames.DataUpdate.Status))?.Value ?? (int)DataUpdateState.Running),
                Cursor = entity.GetAttributeValue<string>(Q(SchemaNames.DataUpdate.Cursor)),
                Succeeded = entity.GetAttributeValue<int>(Q(SchemaNames.DataUpdate.Succeeded)),
                Failed = entity.GetAttributeValue<int>(Q(SchemaNames.DataUpdate.Failed)),
                StartedOn = entity.GetAttributeValue<DateTime?>(Q(SchemaNames.DataUpdate.StartedOn)),
                CompletedOn = entity.GetAttributeValue<DateTime?>(Q(SchemaNames.DataUpdate.CompletedOn)),
                LastPageOn = entity.GetAttributeValue<DateTime?>(Q(SchemaNames.DataUpdate.LastPageOn)),
                RunBy = entity.GetAttributeValue<EntityReference>(Q(SchemaNames.DataUpdate.RunBy))?.Id,
            };
            row.Failures.AddRange(ParseFailures(entity.GetAttributeValue<string>(Q(SchemaNames.DataUpdate.Failures))));
            return row;
        }

        public static string WriteFailures(IEnumerable<DataUpdateFailure> failures) =>
            Write(failures.Take(MaxFailures).Select(f => new FailureDto { Item = f.Item, Message = f.Message }).ToList());

        public static List<DataUpdateFailure> ParseFailures(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new List<DataUpdateFailure>();
            try
            {
                return Read<List<FailureDto>>(json).Select(f => new DataUpdateFailure(f.Item, f.Message)).ToList();
            }
            catch (Exception e) when (e is SerializationException || e is InvalidOperationException)
            {
                throw new InvalidPluginExecutionException("Data update failures are not valid JSON.", e);
            }
        }

        public static string WritePending(IEnumerable<DataUpdateRef> pending) =>
            Write(pending.Select(p => new RefDto { Number = p.Number, Title = p.Title }).ToList());

        public static string WriteLatest(DataUpdateRow row) => Write(new LatestDto
        {
            Number = row.Number,
            Title = row.Title,
            Status = (int)row.State,
            Succeeded = row.Succeeded,
            Failed = row.Failed,
            Failures = row.Failures.Take(MaxFailures).Select(f => new FailureDto { Item = f.Item, Message = f.Message }).ToList(),
        });

        private static string Write<T>(T value)
        {
            using var stream = new MemoryStream();
            new DataContractJsonSerializer(typeof(T)).WriteObject(stream, value);
            return Encoding.UTF8.GetString(stream.ToArray());
        }

        private static T Read<T>(string json)
        {
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(json));
            return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream);
        }

        [DataContract]
        private sealed class FailureDto
        {
            [DataMember(Name = "item", Order = 1)] public string Item { get; set; }
            [DataMember(Name = "message", Order = 2)] public string Message { get; set; }
        }

        [DataContract]
        private sealed class RefDto
        {
            [DataMember(Name = "number", Order = 1)] public int Number { get; set; }
            [DataMember(Name = "title", Order = 2)] public string Title { get; set; }
        }

        [DataContract]
        private sealed class LatestDto
        {
            [DataMember(Name = "number", Order = 1)] public int Number { get; set; }
            [DataMember(Name = "title", Order = 2)] public string Title { get; set; }
            [DataMember(Name = "status", Order = 3)] public int Status { get; set; }
            [DataMember(Name = "succeeded", Order = 4)] public int Succeeded { get; set; }
            [DataMember(Name = "failed", Order = 5)] public int Failed { get; set; }
            [DataMember(Name = "failures", Order = 6)] public List<FailureDto> Failures { get; set; }
        }
    }
}
