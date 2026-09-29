using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Plugin
{
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

        public WriteActionExecutor() : this(null, null) { }

        /// <param name="supportFactory">Builds the bulk-support answer from the system service, once per
        /// executor (one plug-in execution); default: sdkmessagefilter.</param>
        /// <param name="sender">Sends each request; default: IOrganizationService.Execute.</param>
        public WriteActionExecutor(Func<IOrganizationService, IBulkWriteSupport> supportFactory, IWriteRequestSender sender)
        {
            _supportFactory = supportFactory ?? (service => new SdkMessageFilterBulkSupport(service));
            _sender = sender ?? new ServiceWriteRequestSender();
        }

        /// <param name="inPlaceTargets">The in-flight Target of each evaluated record, index-aligned with
        /// <c>outcome.Records</c> (the runner returns one result per input, in input order); a missing or
        /// null entry means no Target (Delete messages). Paired by position, not by id: the Targets of
        /// a CreateMultiple may all carry Guid.Empty.</param>
        public void Execute(RuleEvaluationOutcome outcome, IList<Entity> inPlaceTargets, IOrganizationService userService,
            IOrganizationService systemService, bool engineInitiated, ITracingService trace)
        {
            for (var i = 0; i < outcome.Records.Count; i++)
            {
                var inPlace = inPlaceTargets != null && i < inPlaceTargets.Count ? inPlaceTargets[i] : null;
                ExecuteRecord(outcome.Records[i], inPlace, userService, systemService, engineInitiated, trace);
            }
        }

        /// <summary>Writes one record's change set. Returns the rows sent, plus 1 when an update of the
        /// record being saved was applied in place.</summary>
        public int ExecuteRecord(RecordEvaluationResult record, Entity inPlace, IOrganizationService userService,
            IOrganizationService systemService, bool engineInitiated, ITracingService trace)
        {
            var root = inPlace != null ? new RootRecord(inPlace.LogicalName, record.RecordId) : null;
            var changeSet = ChangeSet.ForRecord(record, root);
            if (changeSet.WriteCount == 0 && !changeSet.HasRootInPlace)
            {
                if (changeSet.Unchanged > 0) trace.Trace($"WriteActionExecutor: {changeSet.Unchanged} row(s) already up to date; nothing to write.");
                return 0;
            }

            var dispatcher = new ChangeSetDispatcher(_support ?? (_support = _supportFactory(systemService)), _sender, trace);
            var applied = dispatcher.ApplyInPlace(changeSet, inPlace) ? 1 : 0;

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
    }
}
