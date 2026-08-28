using System;
using System.Globalization;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// A parsed "dateexpr" payload: anchor (now | a field on the root or a single-cardinality
    /// node) plus an add/subtract interval (amount + unit). This is the shape both the
    /// asx_fieldmapping write side and a condition's ComparisonValueSource.DateExpression RHS
    /// use; <see cref="Parse"/> parses a standalone JSON payload (the condition RHS), while
    /// <see cref="ParseFrom"/> parses an already-loaded XElement fragment (reused by
    /// FieldMappingParser, which parses the whole asx_fieldmapping array in one pass).
    /// </summary>
    public readonly struct DateExprSpec
    {
        public string AnchorKind { get; }   // "now" | "field"
        public Guid? AnchorNode { get; }    // field anchor node; null => root record
        public string AnchorColumn { get; } // field anchor column
        public string Op { get; }           // "add" | "subtract"
        public int Amount { get; }          // positive interval size
        public string Unit { get; }         // minutes|hours|days|weeks|months|years

        public DateExprSpec(string anchorKind, Guid? anchorNode, string anchorColumn, string op, int amount, string unit)
        {
            AnchorKind = anchorKind;
            AnchorNode = anchorNode;
            AnchorColumn = anchorColumn;
            Op = op;
            Amount = amount;
            Unit = unit;
        }

        /// <summary>Parses a standalone dateexpr JSON payload (a condition's asx_comparisonvalue).</summary>
        internal static DateExprSpec Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                throw new InvalidPluginExecutionException("Date expression payload is empty.");

            XElement root;
            try
            {
                using (var reader = JsonReaderWriterFactory.CreateJsonReader(
                    Encoding.UTF8.GetBytes(json), System.Xml.XmlDictionaryReaderQuotas.Max))
                {
                    root = XElement.Load(reader);
                }
            }
            catch (System.Xml.XmlException ex)
            {
                throw new InvalidPluginExecutionException("Date expression payload is not valid JSON.", ex);
            }

            return ParseFrom(root, "Date expression");
        }

        /// <summary>Parses an already-loaded XElement fragment (the dateexpr sub-object of one
        /// asx_fieldmapping entry). Shared with <see cref="Parse"/> so both call sites validate
        /// the same shape identically; errorContext is prepended to every failure message.</summary>
        internal static DateExprSpec ParseFrom(XElement item, string errorContext)
        {
            string ChildValue(XElement el, string name) =>
                el?.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value;
            XElement ChildElement(XElement el, string name) =>
                el?.Elements().FirstOrDefault(e => e.Name.LocalName == name);

            var anchorEl = ChildElement(item, "anchor");
            if (anchorEl == null)
                throw new InvalidPluginExecutionException($"{errorContext} is missing 'anchor'.");

            var anchorKind = ChildValue(anchorEl, "kind");
            Guid? anchorNode = null;
            string anchorColumn = null;
            switch (anchorKind)
            {
                case "now":
                    break;
                case "field":
                    anchorColumn = ChildValue(anchorEl, "column");
                    if (string.IsNullOrWhiteSpace(anchorColumn))
                        throw new InvalidPluginExecutionException(
                            $"{errorContext}: field anchor is missing 'column'.");
                    var nodeRaw = ChildValue(anchorEl, "node");
                    if (!string.IsNullOrEmpty(nodeRaw))
                    {
                        if (Guid.TryParse(nodeRaw, out var parsedNode)) anchorNode = parsedNode;
                        else throw new InvalidPluginExecutionException(
                            $"{errorContext}: anchor 'node' is not a valid GUID.");
                    }
                    break;
                default:
                    throw new InvalidPluginExecutionException(
                        $"{errorContext} has unknown anchor kind '{anchorKind}'. Expected 'now' or 'field'.");
            }

            var op = ChildValue(item, "op");
            if (op != "add" && op != "subtract")
                throw new InvalidPluginExecutionException(
                    $"{errorContext} has unknown op '{op}'. Expected 'add' or 'subtract'.");

            var amountRaw = ChildValue(item, "amount");
            if (!int.TryParse(amountRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var amount) || amount <= 0)
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: 'amount' must be a positive whole number.");

            var unit = ChildValue(item, "unit");
            switch (unit)
            {
                case "minutes": case "hours": case "days": case "weeks": case "months": case "years":
                    break;
                default:
                    throw new InvalidPluginExecutionException(
                        $"{errorContext} has unknown unit '{unit}'. Expected minutes, hours, days, weeks, months, or years.");
            }

            return new DateExprSpec(anchorKind, anchorNode, anchorColumn, op, amount, unit);
        }
    }
}
