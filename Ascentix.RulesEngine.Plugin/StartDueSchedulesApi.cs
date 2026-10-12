using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_StartDueSchedules Custom API, which the
    /// scheduler add-on calls on a timer. Starts or continues a run for every due Rule Schedule
    /// (see <see cref="DueScheduleProcessor"/>) and returns the runs to drive as a JSON array.
    /// IncludeDiagnostics (input) opts into the Diagnostics (output) JSON for this call.
    /// </summary>
    public class StartDueSchedulesApi : PluginBase
    {
        public StartDueSchedulesApi() : base(typeof(StartDueSchedulesApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            if (local == null) throw new ArgumentNullException(nameof(local));

            var context = local.PluginExecutionContext;
            var overall = Stopwatch.StartNew();
            // Only built when asked for: DueScheduleProcessor's diagnostics hooks are all
            // null-guarded, so with IncludeDiagnostics false the call runs exactly as before.
            var diagnostics = DiagnosticsOutput.Requested(context, SchemaNames.StartDueSchedulesApi.ParamIncludeDiagnostics)
                ? new RunDiagnostics()
                : null;
            var result = new DueScheduleProcessor(local.SystemUserService, context.InitiatingUserId, local.TracingService,
                    () => DateTime.UtcNow, diagnostics: diagnostics)
                .Process();
            if (diagnostics != null) diagnostics.TotalMs = overall.ElapsedMilliseconds;

            context.OutputParameters[SchemaNames.StartDueSchedulesApi.PropRunIds] = WriteIds(result.RunIds);
            context.OutputParameters[SchemaNames.StartDueSchedulesApi.PropScheduledCount] = result.ScheduledCount;
            DiagnosticsOutput.SetIfRequested(context, SchemaNames.StartDueSchedulesApi.ParamIncludeDiagnostics,
                SchemaNames.StartDueSchedulesApi.PropDiagnostics, diagnostics);
        }

        private static string WriteIds(IEnumerable<Guid> ids)
        {
            var list = ids.Select(id => id.ToString()).ToList();
            using (var ms = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(List<string>)).WriteObject(ms, list);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }
    }
}
