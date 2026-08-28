using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>Pairs an evaluated record to its in-flight Target entity (for root-in-place writes).</summary>
    public class WriteTarget
    {
        public System.Guid RecordId { get; set; }
        public Entity InPlace { get; set; } // the Create/Update Target; null on Delete messages
    }

    /// <summary>
    /// Applies the WriteIntents produced by the engine. Service writes (Create / related Update /
    /// Delete) carry the <see cref="PluginReentry.EngineWriteTag"/> 'tag' shared variable so a
    /// re-triggered engine execution recognizes its own cascade and skips: a no-op for those when
    /// <paramref name="engineInitiated"/> is true. Root-targeted Update writes onto the in-flight
    /// Target (no new operation, cannot cascade) and always apply. Any failure propagates → the
    /// platform rolls back. Block-wins is handled by the caller (it throws before invoking this).
    /// </summary>
    public class WriteActionExecutor
    {
        public void Execute(
            RuleEvaluationOutcome outcome,
            IList<WriteTarget> records,
            IOrganizationService userService,
            IOrganizationService systemService,
            bool engineInitiated,
            ITracingService trace)
        {
            var targetsById = records.ToDictionary(r => r.RecordId, r => r.InPlace);

            foreach (var record in outcome.Records)
            {
                targetsById.TryGetValue(record.RecordId, out var inPlace);

                var intents = record.FiredActions
                    .Where(a => a.WriteIntent != null)
                    .Select(a => a.WriteIntent);

                foreach (var intent in intents)
                {
                    // Root-in-place writes issue no new operation, so they never re-trigger the
                    // engine and always apply. Service writes could cascade, so skip them when this
                    // execution is itself an engine-initiated write.
                    if (!IsRootInPlace(intent, inPlace) && engineInitiated)
                    {
                        trace.Trace($"WriteActionExecutor: engine-initiated re-entry, skipping {intent.Operation} on {intent.TargetTable}.");
                        continue;
                    }
                    Apply(intent, inPlace, userService, systemService, trace);
                }
            }
        }

        private static bool IsRootInPlace(WriteIntent intent, Entity inPlace) =>
            intent.Operation == WriteOperation.Update && intent.RootTargeted && inPlace != null;

        private void Apply(WriteIntent intent, Entity inPlace,
            IOrganizationService userService, IOrganizationService systemService, ITracingService trace)
        {
            var service = intent.Context == RuleEvaluationContext.System ? systemService : userService;

            switch (intent.Operation)
            {
                case WriteOperation.Create:
                    var toCreate = new Entity(intent.TargetTable);
                    CopyValues(intent, toCreate);
                    Tagged(service, new CreateRequest { Target = toCreate });
                    trace.Trace($"WriteActionExecutor: created {intent.TargetTable}.");
                    break;

                case WriteOperation.Update:
                    if (IsRootInPlace(intent, inPlace))
                    {
                        CopyValues(intent, inPlace); // written with the in-flight operation
                        trace.Trace($"WriteActionExecutor: applied {intent.Values.Count} value(s) to root in place.");
                    }
                    else
                    {
                        var toUpdate = new Entity(intent.TargetTable, intent.TargetId.Value);
                        CopyValues(intent, toUpdate);
                        Tagged(service, new UpdateRequest { Target = toUpdate });
                        trace.Trace($"WriteActionExecutor: updated {intent.TargetTable} {intent.TargetId}.");
                    }
                    break;

                case WriteOperation.Delete:
                    Tagged(service, new DeleteRequest
                    {
                        Target = new EntityReference(intent.TargetTable, intent.TargetId.Value)
                    });
                    trace.Trace($"WriteActionExecutor: deleted {intent.TargetTable} {intent.TargetId}.");
                    break;
            }
        }

        // Issues the request with the engine's loop-marker so any plugin it re-triggers can tell
        // the write originated from the engine (see PluginReentry.IsEngineInitiated).
        private static void Tagged(IOrganizationService service, OrganizationRequest request)
        {
            request["tag"] = PluginReentry.EngineWriteTag;
            service.Execute(request);
        }

        private static void CopyValues(WriteIntent intent, Entity target)
        {
            foreach (var kv in intent.Values)
                target[kv.Key] = kv.Value;
        }
    }
}
