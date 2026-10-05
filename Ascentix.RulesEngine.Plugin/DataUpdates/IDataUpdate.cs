using System;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Plugin.DataUpdates
{
    /// <summary>
    /// One release's conversion of existing engine data. Numbered (1, 2, 3…; never renumbered or
    /// reused) and run in Number order by DataUpdateProcessor, a time-boxed slice per call. A slice
    /// that throws rolls back whole and runs again, so every update must be idempotent per item.
    /// </summary>
    public interface IDataUpdate
    {
        int Number { get; }
        string Title { get; }

        /// <summary>
        /// Does work from <paramref name="cursor"/> (null = from the start) until done or
        /// <paramref name="overBudget"/> returns true. Throws DataUpdateItemException for an item that
        /// fails; the caller re-calls and the processor records it through <see cref="Skip"/>.
        /// </summary>
        DataUpdateStep RunStep(DataUpdateContext context, string cursor, Func<bool> overBudget);

        /// <summary>Returns a cursor that makes later slices skip <paramref name="item"/>. Does no other work.</summary>
        string Skip(string cursor, string item);
    }

    public sealed class DataUpdateContext
    {
        public DataUpdateContext(IOrganizationService system, ITracingService trace, Guid callerId)
        {
            System = system;
            Trace = trace;
            CallerId = callerId;
        }

        public IOrganizationService System { get; }
        public ITracingService Trace { get; }
        public Guid CallerId { get; }
    }

    public sealed class DataUpdateStep
    {
        public DataUpdateStep(string cursor, bool done, int succeeded)
        {
            Cursor = cursor;
            Done = done;
            Succeeded = succeeded;
        }

        public string Cursor { get; }
        public bool Done { get; }
        /// <summary>Items this slice converted.</summary>
        public int Succeeded { get; }
    }

    /// <summary>
    /// One item failed. The call rolls back; asx_ApplyDataUpdates reports
    /// <c>asx_ApplyDataUpdates:item-failed:&lt;item&gt;:&lt;message&gt;</c> and the caller re-calls with
    /// FailedItem. The item is an id the update understands (e.g. a guid): no ':' and no whitespace,
    /// so callers can split the error.
    /// </summary>
    public sealed class DataUpdateItemException : Exception
    {
        public DataUpdateItemException(string item, string message) : base(message)
        {
            if (string.IsNullOrEmpty(item) || item.IndexOf(':') >= 0 || item.Any(char.IsWhiteSpace))
                throw new ArgumentException("A data update item must be non-empty, with no ':' or whitespace.", nameof(item));
            Item = item;
        }

        public string Item { get; }
    }
}
