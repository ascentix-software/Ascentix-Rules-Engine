using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>Sends one organization request (a seam: tests record requests instead).</summary>
    public interface IWriteRequestSender
    {
        void Send(IOrganizationService service, OrganizationRequest request);
    }

    public sealed class ServiceWriteRequestSender : IWriteRequestSender
    {
        public void Send(IOrganizationService service, OrganizationRequest request) => service.Execute(request);
    }

    /// <summary>Whether a table supports a bulk message (CreateMultiple / UpdateMultiple).</summary>
    public interface IBulkWriteSupport
    {
        bool Supports(string message, string table);
    }

    /// <summary>Answers bulk support from sdkmessagefilter: one query per (message, table), cached for
    /// this instance's lifetime (one plug-in execution).</summary>
    public sealed class SdkMessageFilterBulkSupport : IBulkWriteSupport
    {
        private readonly IOrganizationService _service;
        private readonly Dictionary<string, bool> _cache = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

        public SdkMessageFilterBulkSupport(IOrganizationService service) { _service = service; }

        public bool Supports(string message, string table)
        {
            var key = message + "|" + table;
            if (_cache.TryGetValue(key, out var known)) return known;
            var query = new QueryExpression("sdkmessagefilter") { ColumnSet = new ColumnSet("sdkmessagefilterid"), TopCount = 1 };
            query.Criteria.AddCondition("primaryobjecttypecode", ConditionOperator.Equal, table);
            var link = query.AddLink("sdkmessage", "sdkmessageid", "sdkmessageid");
            link.LinkCriteria.AddCondition("name", ConditionOperator.Equal, message);
            var supported = _service.RetrieveMultiple(query).Entities.Count > 0;
            _cache[key] = supported;
            return supported;
        }
    }

    /// <summary>
    /// Sends a <see cref="ChangeSet"/>'s batches in order. Creates and updates: a batch of 2 or more
    /// rows on a table that supports the bulk message goes as CreateMultiple / UpdateMultiple in
    /// requests of at most <see cref="BulkChunkSize"/> rows; otherwise single requests. An update
    /// carrying statecode goes single unless UpdateMultiple is proven to accept it. Deletes are
    /// always single (DeleteMultiple is elastic-only). Every request carries the engine tag. A
    /// failure is rethrown prefixed with the operation, the table and (single requests) the action.
    /// </summary>
    public sealed class ChangeSetDispatcher
    {
        public const int BulkChunkSize = 100;

        /// <summary>Proven on DEV (see the multi-record actions plan, Task 11): does UpdateMultiple
        /// accept a statecode change? While false, a Deactivate goes as a single Update.</summary>
        public const bool UpdateMultipleAcceptsStateChange = false;

        private readonly IBulkWriteSupport _support;
        private readonly IWriteRequestSender _sender;
        private readonly ITracingService _trace;
        private readonly bool _bulkStateChanges;

        public ChangeSetDispatcher(IBulkWriteSupport support, IWriteRequestSender sender, ITracingService trace,
            bool bulkStateChanges = UpdateMultipleAcceptsStateChange)
        {
            _support = support;
            _sender = sender;
            _trace = trace;
            _bulkStateChanges = bulkStateChanges;
        }

        /// <summary>Copies the root-in-place values onto the in-flight Target. True when the change set
        /// had an update of the record being saved and a Target to write it onto.</summary>
        public bool ApplyInPlace(ChangeSet changeSet, Entity inPlace)
        {
            if (inPlace == null || !changeSet.HasRootInPlace) return false;
            foreach (var kv in changeSet.RootInPlaceValues) inPlace[kv.Key] = kv.Value;
            _trace?.Trace($"ChangeSetDispatcher: applied {changeSet.RootInPlaceValues.Count} value(s) to the record in place.");
            return true;
        }

        /// <summary>Sends every batch; returns the number of rows written.</summary>
        public int SendBatches(ChangeSet changeSet, IOrganizationService userService, IOrganizationService systemService)
        {
            var sent = 0;
            foreach (var batch in changeSet.Batches)
            {
                var service = batch.Context == RuleEvaluationContext.System ? systemService : userService;
                switch (batch.Operation)
                {
                    case WriteOperation.Delete:
                        foreach (var write in batch.Writes)
                            SendSingle(service, write, new DeleteRequest { Target = new EntityReference(write.Table, write.Id) });
                        break;
                    case WriteOperation.Create:
                        SendCreatesOrUpdates(service, batch, batch.Writes, "CreateMultiple");
                        break;
                    default:
                        var bulkable = batch.Writes.Where(w => _bulkStateChanges || !w.Values.ContainsKey("statecode")).ToList();
                        SendCreatesOrUpdates(service, batch, bulkable, "UpdateMultiple");
                        foreach (var write in batch.Writes.Except(bulkable))
                            SendSingle(service, write, new UpdateRequest { Target = ToEntity(write) });
                        break;
                }
                sent += batch.Writes.Count;
            }
            return sent;
        }

        private void SendCreatesOrUpdates(IOrganizationService service, ChangeSetBatch batch, IReadOnlyList<ChangeSetWrite> writes, string bulkMessage)
        {
            var isCreate = batch.Operation == WriteOperation.Create;
            if (writes.Count >= 2 && _support.Supports(bulkMessage, batch.Table))
            {
                for (var start = 0; start < writes.Count; start += BulkChunkSize)
                {
                    var targets = new EntityCollection(writes.Skip(start).Take(BulkChunkSize).Select(ToEntity).ToList()) { EntityName = batch.Table };
                    OrganizationRequest request = isCreate
                        ? (OrganizationRequest)new CreateMultipleRequest { Targets = targets }
                        : new UpdateMultipleRequest { Targets = targets };
                    try { Tagged(service, request); }
                    catch (Exception ex) { throw new InvalidPluginExecutionException($"{bulkMessage} {batch.Table}: {ex.Message}", ex); }
                    _trace?.Trace($"ChangeSetDispatcher: {bulkMessage} {batch.Table} ({targets.Entities.Count} rows).");
                }
                return;
            }
            foreach (var write in writes)
                SendSingle(service, write, isCreate ? (OrganizationRequest)new CreateRequest { Target = ToEntity(write) } : new UpdateRequest { Target = ToEntity(write) });
        }

        private void SendSingle(IOrganizationService service, ChangeSetWrite write, OrganizationRequest request)
        {
            try { Tagged(service, request); }
            catch (Exception ex)
            {
                throw new InvalidPluginExecutionException($"{write.Operation} {write.Table} (action \"{write.ActionLabel}\"): {ex.Message}", ex);
            }
            _trace?.Trace($"ChangeSetDispatcher: {write.Operation} {write.Table} {write.Id}.");
        }

        private void Tagged(IOrganizationService service, OrganizationRequest request)
        {
            request["tag"] = PluginReentry.EngineWriteTag;
            _sender.Send(service, request);
        }

        private static Entity ToEntity(ChangeSetWrite write)
        {
            var entity = write.Id == Guid.Empty ? new Entity(write.Table) : new Entity(write.Table, write.Id);
            foreach (var kv in write.Values) entity[kv.Key] = kv.Value;
            return entity;
        }
    }
}
