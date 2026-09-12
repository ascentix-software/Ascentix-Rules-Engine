using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    internal static class DraftReferenceRemapper
    {
        private const string GuidPattern = @"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

        public static string Rewrite(SnapshotRow row, string field, string text, IReadOnlyDictionary<Guid, Guid> models)
        {
            if (string.IsNullOrEmpty(text)) return text;
            if (field == "asx_message") return Template(text, models);
            if (field == "asx_conditionexpression") return Expression(text, models);
            if (field == "asx_fieldmapping") return Json(text, models, true);
            if (field == "asx_comparisonvalue" && row.Attributes.TryGetValue("asx_comparisonvaluesource", out var source))
            {
                var kind = (source.ToSdk() as OptionSetValue)?.Value;
                if (kind == 3) return Template(text, models);
                if (kind == 4) return Json(text, models, false);
            }
            return text;
        }

        private static string Map(string text, IReadOnlyDictionary<Guid, Guid> models) =>
            Guid.TryParse(text, out var id) && models.TryGetValue(id, out var mapped) ? mapped.ToString() : text;

        private static string Expression(string text, IReadOnlyDictionary<Guid, Guid> models) =>
            Regex.Replace(text, "node:(" + GuidPattern + ")", m => "node:" + Map(m.Groups[1].Value, models));

        private static string Template(string text, IReadOnlyDictionary<Guid, Guid> models)
        {
            var result = new StringBuilder();
            for (var i = 0; i < text.Length; i++)
            {
                if (text[i] == '{' && i + 1 < text.Length && text[i + 1] == '{')
                { result.Append("{{"); i++; continue; }
                if (text[i] == '{')
                {
                    var close = text.IndexOf('}', i + 1);
                    if (close >= 0)
                    {
                        var token = text.Substring(i + 1, close - i - 1);
                        result.Append('{').Append(Regex.Replace(token, "^node:(" + GuidPattern + @")(?=\.)",
                            m => "node:" + Map(m.Groups[1].Value, models))).Append('}');
                        i = close;
                        continue;
                    }
                }
                result.Append(text[i]);
            }
            return result.ToString();
        }

        private static string Json(string text, IReadOnlyDictionary<Guid, Guid> models, bool mapping)
        {
            XElement root;
            using (var reader = JsonReaderWriterFactory.CreateJsonReader(Encoding.UTF8.GetBytes(text), XmlDictionaryReaderQuotas.Max))
                root = XElement.Load(reader);
            XElement Child(XElement element, string name) => element?.Elements().FirstOrDefault(e => e.Name.LocalName == name);
            void Remap(XElement element) { if (element != null && !element.HasElements) element.Value = Map(element.Value, models); }
            void Anchor(XElement element) { Remap(Child(Child(element, "anchor"), "node")); }
            if (!mapping) Anchor(root);
            else foreach (var entry in root.Elements())
            {
                switch (Child(entry, "source")?.Value)
                {
                    case "node": case "ref": Remap(Child(entry, "node")); break;
                    case "dateexpr": Anchor(entry); break;
                    case "template":
                        var template = Child(entry, "template");
                        if (template != null) template.Value = Template(template.Value, models);
                        break;
                    case "mathexpr":
                        var expression = Child(entry, "expression");
                        if (expression != null) expression.Value = Expression(expression.Value, models);
                        var filters = Child(entry, "filters");
                        if (filters != null)
                            foreach (var reference in filters.Descendants().Where(e => e.Name.LocalName == "valueNodeId" || e.Name.LocalName == "collectionNodeId"))
                                Remap(reference);
                        break;
                }
            }
            using (var stream = new MemoryStream())
            {
                using (var writer = JsonReaderWriterFactory.CreateJsonWriter(stream, Encoding.UTF8, false)) root.WriteTo(writer);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }
}
