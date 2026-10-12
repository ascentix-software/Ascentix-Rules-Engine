using System;
using System.Collections.Generic;
using FakeXrmEasy;
using FakeXrmEasy.FakeMessageExecutors;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>RetrieveEntityRequest for several tables (FakeXrmEasy keeps one executor per
    /// request type, so FakeAttributeMetadataExecutor alone covers a single table).</summary>
    internal sealed class FakeTablesMetadataExecutor : IFakeMessageExecutor
    {
        private readonly Dictionary<string, AttributeMetadata[]> _tables;
        public FakeTablesMetadataExecutor(Dictionary<string, AttributeMetadata[]> tables) { _tables = tables; }
        public bool CanExecute(OrganizationRequest request) => request is RetrieveEntityRequest r && _tables.ContainsKey(r.LogicalName);
        public Type GetResponsibleRequestType() => typeof(RetrieveEntityRequest);
        public OrganizationResponse Execute(OrganizationRequest request, XrmFakedContext ctx)
        {
            var table = ((RetrieveEntityRequest)request).LogicalName;
            return new FakeAttributeMetadataExecutor(table, _tables[table]).Execute(request, ctx);
        }
    }
}
