using System.Collections.Generic;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>Parses an asx_triggercolumns payload (a JSON array of root-table column logical
    /// names ["col1","col2"]) into a list. Blank/malformed yields an empty list (never throws);
    /// the value is admin-authored config. Sandbox-safe.</summary>
    public static class TriggerColumns
    {
        public static List<string> Parse(string json)
        {
            var result = new List<string>();
            if (string.IsNullOrWhiteSpace(json)) return result;
            try
            {
                using (var reader = JsonReaderWriterFactory.CreateJsonReader(
                    Encoding.UTF8.GetBytes(json), XmlDictionaryReaderQuotas.Max))
                {
                    var root = XElement.Load(reader);
                    // JsonReaderWriterFactory renders a JSON array as <root type="array"><item>...
                    if (root.Attribute("type")?.Value != "array") return result;
                    foreach (var item in root.Elements())
                        if (!string.IsNullOrWhiteSpace(item.Value))
                            result.Add(item.Value.Trim());
                }
            }
            catch (XmlException) { /* malformed → empty */ }
            return result;
        }
    }
}
