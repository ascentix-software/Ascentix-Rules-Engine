using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_StartDueSchedules Custom API, which the
    /// scheduler add-on calls on a timer. Starts or continues a run for every due Rule Schedule
    /// (see <see cref="DueScheduleProcessor"/>) and returns the runs to drive as a JSON array.
    /// </summary>
    public class StartDueSchedulesApi : PluginBase
    {
        public StartDueSchedulesApi() : base(typeof(StartDueSchedulesApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            if (local == null) throw new ArgumentNullException(nameof(local));

            var context = local.PluginExecutionContext;
            var result = new DueScheduleProcessor(local.SystemUserService, context.InitiatingUserId, local.TracingService,
                    () => DateTime.UtcNow)
                .Process();

            context.OutputParameters[SchemaNames.StartDueSchedulesApi.PropRunIds] = WriteIds(result.RunIds);
            context.OutputParameters[SchemaNames.StartDueSchedulesApi.PropScheduledCount] = result.ScheduledCount;
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
