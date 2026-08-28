using System;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Decodes the asx_RunRules RecordJson payload (a flat { logicalname: value } object) into
    /// an Entity overlay. Uses JsonReaderWriterFactory (System.Runtime.Serialization, sandbox-safe).
    /// Encoding contract (see docs/Schema.md §3):
    ///   string→string, boolean→bool, integral number→int, fractional number→decimal,
    ///   array of ints→OptionSetValueCollection (multi-select), { id, logicalname }→EntityReference,
    ///   null→null attribute. Single-select optionsets/money/dates are sent as their primitive
    ///   form and compared by value (the engine stringifies for comparison).
    /// </summary>
    public static class RecordJsonDeserializer
    {
        public static Entity Deserialize(string logicalName, string json)
        {
            var entity = new Entity(logicalName);
            if (string.IsNullOrWhiteSpace(json)) return entity;

            XElement root;
            try
            {
                using (var reader = JsonReaderWriterFactory.CreateJsonReader(
                    Encoding.UTF8.GetBytes(json), XmlDictionaryReaderQuotas.Max))
                {
                    root = XElement.Load(reader);
                }
            }
            catch (System.Xml.XmlException ex)
            {
                throw new InvalidPluginExecutionException(
                    "asx_RunRules: RecordJson is not valid JSON.", ex);
            }

            foreach (var prop in root.Elements())
                entity[prop.Name.LocalName] = JsonPrimitiveDecoder.Decode(prop);

            return entity;
        }

    }
}
