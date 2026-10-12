using FakeItEasy;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Tests
{
    // FakeXrmEasy v1 derives IsInTransaction from stage 20/40 and ignores the context
    // value for Custom API main operation (30). Supply that platform property explicitly.
    public class TransactionalPluginContext : XrmFakedContext
    {
        public void ExecuteTransactional<T>(XrmFakedPluginExecutionContext context) where T : IPlugin, new() =>
            ExecuteTransactional(context, new T());

        /// <summary>Runs a pre-built plug-in instance (e.g. one given a test seam through its constructor).</summary>
        public void ExecuteTransactional(XrmFakedPluginExecutionContext context, IPlugin plugin)
        {
            context.SharedVariables = context.SharedVariables ?? new ParameterCollection();
            var provider = GetFakedServiceProvider(context);
            var execution = (IPluginExecutionContext)provider.GetService(typeof(IPluginExecutionContext));
            A.CallTo(() => execution.IsInTransaction).Returns(true);
            A.CallTo(() => execution.ParentContext).Returns(context.ParentContext);
            A.CallTo(() => execution.CorrelationId).Returns(context.CorrelationId);
            A.CallTo(() => provider.GetService(typeof(IPluginExecutionContext))).Returns(execution);
            plugin.Execute(provider);
        }
    }
}
