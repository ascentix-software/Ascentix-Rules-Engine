using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>A group's combined write failed. <see cref="RecordId"/> is the one record behind the
    /// failed row when it can be named; null when a bulk request (several rows) failed or the failed
    /// row was merged from several records.</summary>
    public sealed class GroupWriteException : Exception
    {
        public GroupWriteException(Guid? recordId, string message, Exception inner) : base(message, inner) { RecordId = recordId; }
        public Guid? RecordId { get; }
    }

    /// <summary>
    /// Fired actions → <see cref="ChangeSet"/> → <see cref="ChangeSetDispatcher"/>, one change set per
    /// evaluated record. An update of the record being saved is written onto the in-flight Target and
    /// always applies. Every other write is a tagged service request (PluginReentry.EngineWriteTag) and
    /// is skipped when this execution is itself engine-initiated. With no in-flight Target (Run page,
    /// asx_ApplyRules) a root update is an ordinary tagged update of the evaluated record. Any failure
    /// propagates, so the platform rolls the record back. Block-wins is the caller's (it throws before
    /// calling this).
    /// </summary>
    public class WriteActionExecutor
    {
        private readonly Func<IOrganizationService, IBulkWriteSupport> _supportFactory;
        private readonly IWriteRequestSender _sender;
        private IBulkWriteSupport _support;

        public WriteActionExecutor() : this(Guid.Empty) { }

        /// <summary>Bulk messages only while the organization's asx_BulkWrites switch is on.</summary>
        public WriteActionExecutor(Guid organizationId)
            : this(service => BulkWrites.Support(BulkWrites.Shared, service, organizationId, null), null) { }

        /// <param name="supportFactory">Builds the bulk-support answer from the system service, once per
        /// executor (one plug-in execution); default: none (every write single).</param>
        /// <param name="sender">Sends each request; default: IOrganizationService.Execute.</param>
        public WriteActionExecutor(Func<IOrganizationService, IBulkWriteSupport> supportFactory, IWriteRequestSender sender)
        {
            _supportFactory = supportFactory ?? (_ => NoBulkSupport.Instance);
            _sender = sender ?? new ServiceWriteRequestSender();
        }

        /// <param name="inPlaceTargets">The in-flight Target of each evaluated record, index-aligned with
        /// <c>outcome.Records</c> (the runner returns one result per input, in input order); a missing or
        /// null entry means no Target (Delete messages). Paired by position, not by id: the Targets of
        /// a CreateMultiple may all carry Guid.Empty.</param>
        /// <param name="diagnostics">Receives the write stages and counters; null means none.</param>
        public void Execute(RuleEvaluationOutcome outcome, IList<Entity> inPlaceTargets, IOrganizationService userService,
            IOrganizationService systemService, bool engineInitiated, ITracingService trace, RunDiagnostics diagnostics = null)
        {
            for (var i = 0; i < outcome.Records.Count; i++)
            {
                var inPlace = inPlaceTargets != null && i < inPlaceTargets.Count ? inPlaceTargets[i] : null;
                ExecuteRecord(outcome.Records[i], inPlace, userService, systemService, engineInitiated, trace, diagnostics);
            }
        }

        /// <summary>Writes one record's change set. Returns the rows sent, plus 1 when an update of the
        /// record being saved was applied in place.</summary>
        public int ExecuteRecord(RecordEvaluationResult record, Entity inPlace, IOrganizationService userService,
            IOrganizationService systemService, bool engineInitiated, ITracingService trace, RunDiagnostics diagnostics = null)
        {
            var root = inPlace != null ? new RootRecord(inPlace.LogicalName, record.RecordId) : null;
            ChangeSet changeSet;
            using (diagnostics?.Time("changeSetBuild"))
                changeSet = ChangeSet.ForRecord(record, root);
            if (diagnostics != null)
            {
                diagnostics.WritesUnchanged += changeSet.Unchanged;
                diagnostics.WritesMerged += changeSet.Merged;
            }
            if (changeSet.WriteCount == 0 && !changeSet.HasRootInPlace)
            {
                if (changeSet.Unchanged > 0) trace.Trace($"WriteActionExecutor: {changeSet.Unchanged} row(s) already up to date; nothing to write.");
                return 0;
            }

            var dispatcher = new ChangeSetDispatcher(_support ?? (_support = _supportFactory(systemService)), _sender, trace,
                diagnostics: diagnostics);
            var applied = 0;
            if (inPlace != null && changeSet.HasRootInPlace)
                using (diagnostics?.Time("applyInPlace"))
                    applied = dispatcher.ApplyInPlace(changeSet, inPlace) ? 1 : 0;
            if (applied == 1 && diagnostics != null) diagnostics.InPlaceWrites++;

            // Service writes could cascade into the engine again, so an engine-initiated execution skips
            // them; the in-place write issues no new operation and always applies.
            if (engineInitiated)
            {
                if (changeSet.WriteCount > 0)
                    trace.Trace($"WriteActionExecutor: engine-initiated re-entry, skipping {changeSet.WriteCount} write(s).");
                return applied;
            }

            trace.Trace($"WriteActionExecutor: {changeSet.Creates} create(s), {changeSet.Updates} update(s), {changeSet.Deletes} delete(s), {changeSet.Unchanged} unchanged.");
            return applied + dispatcher.SendBatches(changeSet, userService, systemService);
        }

        /// <summary>Writes a group of evaluated records (a Rule Run page's chunk) as one combined change
        /// set (<see cref="ChangeSet.Combine"/>). Returns false, sending nothing, when there is no gain
        /// over writing per record — no create or update batch of the combined set can go as a bulk
        /// request — or when this execution is engine-initiated; the caller then writes per record.
        /// <paramref name="written"/> holds the records whose own change set had a write (they count as
        /// changed). A failure throws <see cref="GroupWriteException"/>, naming the record when one record
        /// alone fed the failed single-row request. No in-place writes: a run page has no Target.</summary>
        public bool TryExecuteGroup(IList<RecordEvaluationResult> records, IOrganizationService userService,
            IOrganizationService systemService, bool engineInitiated, ITracingService trace, RunDiagnostics diagnostics,
            out HashSet<Guid> written)
        {
            written = new HashSet<Guid>();
            if (engineInitiated || records == null || records.Count < 2) return false;

            var sets = records.Select(r => (r.RecordId, ChangeSet.ForRecord(r, null))).ToList();
            var combined = ChangeSet.Combine(sets);
            var support = _support ?? (_support = _supportFactory(systemService));
            var bulk = combined.Batches.Any(b => b.Operation != WriteOperation.Delete && b.Writes.Count >= 2
                && support.Supports(b.Operation == WriteOperation.Create ? "CreateMultiple" : "UpdateMultiple", b.Table));
            if (!bulk) return false;

            if (diagnostics != null)
            {
                diagnostics.WritesUnchanged += combined.Unchanged;
                diagnostics.WritesMerged += combined.Merged;
            }
            foreach (var (recordId, set) in sets)
                if (set.WriteCount > 0) written.Add(recordId);

            trace.Trace($"WriteActionExecutor: group of {records.Count} record(s): {combined.Creates} create(s), " +
                        $"{combined.Updates} update(s), {combined.Deletes} delete(s), {combined.Unchanged} unchanged.");
            try
            {
                new ChangeSetDispatcher(support, _sender, trace, diagnostics: diagnostics, tagFailedWrites: true).SendBatches(combined, userService, systemService);
            }
            catch (InvalidPluginExecutionException ex)
            {
                var owners = ex.Data[ChangeSetDispatcher.FailedWriteKey] is FailedWrite failed && failed.Write != null
                    ? combined.RecordsOf(failed.Write) : new Guid[0];
                throw new GroupWriteException(owners.Count == 1 ? owners[0] : (Guid?)null, ex.Message, ex);
            }
            return true;
        }
    }
}
