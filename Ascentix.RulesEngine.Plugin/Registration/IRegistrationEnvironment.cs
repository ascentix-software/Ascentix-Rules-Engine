using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>An existing engine-owned step for a table.</summary>
    public class RegisteredStep
    {
        public Guid Id { get; set; }
        public string MessageName { get; set; }          // Create/CreateMultiple/Update/UpdateMultiple/Delete
        public string FilteringAttributes { get; set; }  // comma-separated; null/empty = fire on all
        public string Name { get; set; }                 // "Ascentix.RulesEngine: {table} {message}"
        public bool IsActive { get; set; } = true;       // statecode == Enabled; admin-deactivated steps are false
    }

    /// <summary>A step to create.</summary>
    public class StepRegistration
    {
        public string TableLogicalName { get; set; }
        public string MessageName { get; set; }
        public string FilteringAttributes { get; set; }  // null/empty = fire on all
    }

    /// <summary>
    /// Everything the reconciler needs from the environment: message-support checks
    /// and engine-owned step CRUD. Implemented by DataverseRegistrationEnvironment;
    /// faked in tests so the reconciler is pure-logic testable.
    /// </summary>
    public interface IRegistrationEnvironment
    {
        bool SupportsMessage(string messageName, string tableLogicalName);
        List<RegisteredStep> GetEngineSteps(string tableLogicalName);
        void CreateStep(StepRegistration registration);
        void UpdateFilteringAttributes(Guid stepId, string filteringAttributes);
        void DeleteStep(Guid stepId);
    }

    /// <summary>
    /// The bulk view StepSyncService (asx_SyncSteps) needs on top of per-table
    /// reconciliation: every engine-owned step in the org, regardless of table.
    /// </summary>
    public interface IStepSyncEnvironment : IRegistrationEnvironment
    {
        /// <summary>All steps on the engine plugin type whose name carries the
        /// engine prefix: both conditions, so neither a customer step that mimics
        /// the name nor our own bootstrap steps are ever included.</summary>
        List<RegisteredStep> GetAllEngineSteps();
    }
}
