using System;
using System.Globalization;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>
    /// Coerces a decoded literal primitive (from JsonPrimitiveDecoder) to the CLR value required to
    /// write the target column, using its AttributeTypeCode. EntityReference/OptionSetValueCollection
    /// primitives pass through (already the write type). Throws InvalidPluginExecutionException for an
    /// unknown column or an incompatible primitive (author error).
    /// </summary>
    public static class LiteralCoercer
    {
        public static object Coerce(object primitive, string table, string column, IAttributeMetadataProvider md)
        {
            if (primitive == null) return null;

            var type = md.GetAttributeType(table, column);
            if (type == null)
                throw new InvalidPluginExecutionException(
                    $"Field mapping targets column '{column}' which does not exist on table '{table}'.");

            try
            {
                switch (type.Value)
                {
                    case AttributeTypeCode.Picklist:
                    case AttributeTypeCode.State:
                    case AttributeTypeCode.Status:
                        return new OptionSetValue(ToInt(primitive));

                    case AttributeTypeCode.Money:
                        return new Money(ToDecimal(primitive));

                    case AttributeTypeCode.Integer:
                    case AttributeTypeCode.BigInt:
                        return ToInt(primitive);

                    case AttributeTypeCode.Decimal:
                        return ToDecimal(primitive);

                    case AttributeTypeCode.Double:
                        return Convert.ToDouble(primitive, CultureInfo.InvariantCulture);

                    case AttributeTypeCode.Boolean:
                        return Convert.ToBoolean(primitive, CultureInfo.InvariantCulture);

                    case AttributeTypeCode.DateTime:
                        return primitive is DateTime dt
                            ? dt
                            : DateTime.Parse((string)primitive, CultureInfo.InvariantCulture,
                                DateTimeStyles.RoundtripKind);

                    case AttributeTypeCode.Lookup:
                    case AttributeTypeCode.Customer:
                    case AttributeTypeCode.Owner:
                        if (primitive is EntityReference er) return er;
                        throw Incompatible(primitive, column, type.Value);

                    case AttributeTypeCode.Virtual: // multi-select option set
                        if (primitive is OptionSetValueCollection col) return col;
                        throw Incompatible(primitive, column, type.Value);

                    case AttributeTypeCode.Uniqueidentifier:
                        return primitive is Guid g ? g : Guid.Parse((string)primitive);

                    default: // String, Memo, and any text-like type
                        return primitive is string s ? s : Convert.ToString(primitive, CultureInfo.InvariantCulture);
                }
            }
            catch (InvalidPluginExecutionException) { throw; }
            catch (Exception ex)
            {
                throw Incompatible(primitive, column, type.Value, ex);
            }
        }

        private static int ToInt(object v) => Convert.ToInt32(v, CultureInfo.InvariantCulture);
        private static decimal ToDecimal(object v) => Convert.ToDecimal(v, CultureInfo.InvariantCulture);

        private static InvalidPluginExecutionException Incompatible(
            object primitive, string column, AttributeTypeCode type, Exception inner = null)
            => new InvalidPluginExecutionException(
                $"Field mapping value '{primitive}' is not valid for column '{column}' ({type}).", inner);
    }
}
