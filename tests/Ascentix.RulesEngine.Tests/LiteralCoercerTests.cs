using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class LiteralCoercerTests
    {
        private sealed class FakeMetadata : IAttributeMetadataProvider
        {
            private readonly Dictionary<string, AttributeTypeCode> _map;
            public FakeMetadata(Dictionary<string, AttributeTypeCode> map) { _map = map; }
            public AttributeTypeCode? GetAttributeType(string table, string column) =>
                _map.TryGetValue(column, out var t) ? t : (AttributeTypeCode?)null;
        }

        private static object Coerce(object primitive, string column, AttributeTypeCode type)
        {
            var md = new FakeMetadata(new Dictionary<string, AttributeTypeCode> { [column] = type });
            return LiteralCoercer.Coerce(primitive, "account", column, md);
        }

        [Fact]
        public void Int_to_picklist_becomes_optionsetvalue()
        {
            var v = Assert.IsType<OptionSetValue>(Coerce(2, "statuscode", AttributeTypeCode.Picklist));
            Assert.Equal(2, v.Value);
        }

        [Fact]
        public void Int_to_status_and_state_becomes_optionsetvalue()
        {
            Assert.IsType<OptionSetValue>(Coerce(1, "statuscode", AttributeTypeCode.Status));
            Assert.IsType<OptionSetValue>(Coerce(0, "statecode", AttributeTypeCode.State));
        }

        [Fact]
        public void Int_to_integer_stays_int()
        {
            Assert.Equal(5, Coerce(5, "numberofemployees", AttributeTypeCode.Integer));
        }

        [Fact]
        public void Number_to_money_becomes_money()
        {
            var m = Assert.IsType<Money>(Coerce(100.50m, "revenue", AttributeTypeCode.Money));
            Assert.Equal(100.50m, m.Value);
        }

        [Fact]
        public void Int_to_money_becomes_money()
        {
            var m = Assert.IsType<Money>(Coerce(100, "revenue", AttributeTypeCode.Money));
            Assert.Equal(100m, m.Value);
        }

        [Fact]
        public void String_to_datetime_parses_iso()
        {
            var dt = Assert.IsType<DateTime>(Coerce("2026-06-20T00:00:00Z", "createdon", AttributeTypeCode.DateTime));
            Assert.Equal(2026, dt.Year);
        }

        [Fact]
        public void Entityreference_passes_through_for_lookup()
        {
            var er = new EntityReference("systemuser", Guid.NewGuid());
            Assert.Same(er, Coerce(er, "ownerid", AttributeTypeCode.Lookup));
        }

        [Fact]
        public void String_to_string_passes_through()
        {
            Assert.Equal("Acme", Coerce("Acme", "name", AttributeTypeCode.String));
        }

        [Fact]
        public void Null_passes_through()
        {
            Assert.Null(Coerce(null, "name", AttributeTypeCode.String));
        }

        [Fact]
        public void Unknown_column_throws()
        {
            var md = new FakeMetadata(new Dictionary<string, AttributeTypeCode>());
            Assert.Throws<InvalidPluginExecutionException>(
                () => LiteralCoercer.Coerce(1, "account", "missing", md));
        }

        [Fact]
        public void Incompatible_primitive_throws()
        {
            // string into a picklist column cannot be coerced
            Assert.Throws<InvalidPluginExecutionException>(
                () => Coerce("nope", "statuscode", AttributeTypeCode.Picklist));
        }
    }
}
