using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ServerActionClassificationTests
    {
        [Theory]
        [InlineData(ActionType.Block, true)]
        [InlineData(ActionType.CreateRecord, true)]
        [InlineData(ActionType.UpdateRecord, true)]
        [InlineData(ActionType.DeleteRecord, true)]
        [InlineData(ActionType.SetVisible, false)]
        [InlineData(ActionType.SetRequired, false)]
        [InlineData(ActionType.ShowMessage, false)]
        public void IsServerAction_classifies_write_and_block_actions_as_server(ActionType type, bool expected)
        {
            Assert.Equal(expected, ActionDispatcher.IsServerAction(type));
        }
    }
}
