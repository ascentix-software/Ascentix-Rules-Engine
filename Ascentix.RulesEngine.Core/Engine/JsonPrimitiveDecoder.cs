using System;
using System.Globalization;
using System.Linq;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Decodes a single JSON value (parsed via JsonReaderWriterFactory into an XElement) into a
    /// primitive CLR value following the RecordJson encoding contract (docs/Schema.md §3):
    ///   null→null, boolean→bool, integral number→int, fractional number→decimal,
    ///   { id, logicalname }→EntityReference, array of ints→OptionSetValueCollection,
    ///   string (and unknown)→string. Sandbox-safe (System.Xml only).
    /// </summary>
    public static class JsonPrimitiveDecoder
    {
        public static object Decode(XElement element)
        {
            var type = element.Attribute("type")?.Value;
            switch (type)
            {
                case "null": return null;
                case "boolean": return XmlConvert.ToBoolean(element.Value);
                case "number": return DecodeNumber(element.Value);
                case "object": return DecodeLookup(element);
                case "array": return DecodeMultiSelect(element);
                default: return element.Value;
            }
        }

        private static object DecodeNumber(string raw)
        {
            var value = decimal.Parse(raw, NumberStyles.Any, CultureInfo.InvariantCulture);
            if (value == Math.Truncate(value) && value >= int.MinValue && value <= int.MaxValue)
                return (int)value;
            return value;
        }

        private static EntityReference DecodeLookup(XElement element)
        {
            var id = element.Elements().FirstOrDefault(e => e.Name.LocalName == "id")?.Value;
            var logicalName = element.Elements().FirstOrDefault(e => e.Name.LocalName == "logicalname")?.Value;
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(logicalName))
                throw new InvalidPluginExecutionException(
                    "A lookup value must be an object with 'id' and 'logicalname'.");
            return new EntityReference(logicalName, Guid.Parse(id));
        }

        private static OptionSetValueCollection DecodeMultiSelect(XElement element)
        {
            var values = element.Elements()
                .Select(item => new OptionSetValue(
                    (int)decimal.Parse(item.Value, NumberStyles.Any, CultureInfo.InvariantCulture)))
                .ToList();
            return new OptionSetValueCollection(values);
        }
    }
}
