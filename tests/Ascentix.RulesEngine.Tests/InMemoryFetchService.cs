using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Answers the executor's child and lookup FetchXML from in-memory rows: the first condition's
    /// attribute and its in-values select the rows (an EntityReference column, or the row's own id for a
    /// lookup's id attribute). Pushed filters are ignored (the executor's fetches are supersets anyway).
    /// Every call returns fresh copies, one page, and is recorded.
    /// </summary>
    internal sealed class InMemoryFetchService : IOrganizationService
    {
        private readonly Dictionary<string, List<Entity>> _rows = new Dictionary<string, List<Entity>>(StringComparer.OrdinalIgnoreCase);
        public readonly List<string> Fetches = new List<string>();

        public InMemoryFetchService Add(params Entity[] rows)
        {
            foreach (var row in rows)
            {
                if (!_rows.TryGetValue(row.LogicalName, out var list)) _rows[row.LogicalName] = list = new List<Entity>();
                list.Add(row);
            }
            return this;
        }

        public int Count(string table) => Fetches.Count(x => x.Contains($"name='{table}'"));

        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            var xml = ((FetchExpression)query).Query;
            Fetches.Add(xml);
            var table = Regex.Match(xml, "<entity name='([^']+)'").Groups[1].Value;
            var attribute = Regex.Match(xml, "<condition attribute='([^']+)'\\s+operator='in'").Groups[1].Value;
            var inBlock = Regex.Match(xml, "operator='in'>(.*?)</condition>", RegexOptions.Singleline).Groups[1].Value;
            var values = new HashSet<Guid>(Regex.Matches(inBlock, "<value>([^<]+)</value>").Cast<Match>().Select(m => Guid.Parse(m.Groups[1].Value)));
            var result = new EntityCollection { EntityName = table, MoreRecords = false };
            if (!_rows.TryGetValue(table, out var rows)) return result;
            foreach (var row in rows)
            {
                Guid key;
                if (string.Equals(attribute, table + "id", StringComparison.OrdinalIgnoreCase)) key = row.Id;
                else if (row.GetAttributeValue<EntityReference>(attribute) is EntityReference r) key = r.Id;
                else continue;
                if (!values.Contains(key)) continue;
                var copy = new Entity(row.LogicalName, row.Id);
                foreach (var a in row.Attributes) copy[a.Key] = a.Value;
                result.Entities.Add(copy);
            }
            return result;
        }

        public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
        public Guid Create(Entity entity) => throw new NotSupportedException();
        public void Update(Entity entity) => throw new NotSupportedException();
        public void Delete(string entityName, Guid id) => throw new NotSupportedException();
        public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
        public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
    }
}
