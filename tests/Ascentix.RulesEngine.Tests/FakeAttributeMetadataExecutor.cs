using System;
using FakeXrmEasy;
using FakeXrmEasy.FakeMessageExecutors;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Answers RetrieveEntityRequest for one table with the given attribute metadata, so
    /// AttributeMetadataProvider / LiteralCoercer can resolve field-mapping literal types inside
    /// the runner (FakeXrmEasy has no metadata for a plain seeded table by default). Register via
    /// ctx.AddFakeMessageExecutor&lt;RetrieveEntityRequest&gt;(new FakeAttributeMetadataExecutor(...)).
    /// </summary>
    internal sealed class FakeAttributeMetadataExecutor : IFakeMessageExecutor
    {
        private readonly string _table;
        private readonly AttributeMetadata[] _attributes;

        public FakeAttributeMetadataExecutor(string table, params AttributeMetadata[] attributes)
        {
            _table = table;
            _attributes = attributes;
        }

        public bool CanExecute(OrganizationRequest request)
            => request is RetrieveEntityRequest req && req.LogicalName == _table;

        public Type GetResponsibleRequestType() => typeof(RetrieveEntityRequest);

        public OrganizationResponse Execute(OrganizationRequest request, XrmFakedContext ctx)
        {
            var entityMeta = new EntityMetadata { LogicalName = _table };

            // Attributes has no public setter in the SDK; inject via reflection.
            var attrsProp = typeof(EntityMetadata).GetProperty("Attributes");
            if (attrsProp != null)
                attrsProp.SetValue(entityMeta, _attributes);
            else
            {
                var field = typeof(EntityMetadata).GetField("_attributes",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                field?.SetValue(entityMeta, _attributes);
            }

            return new RetrieveEntityResponse
            {
                Results = new ParameterCollection { { "EntityMetadata", entityMeta } }
            };
        }
    }
}
