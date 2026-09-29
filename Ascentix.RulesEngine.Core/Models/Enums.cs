namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Enums ────────────────────────────────────────────────────────────────

    public enum TableConfigType
    {
        RootTable = 1,
        LookupTable = 2,
        ChildTable = 3
    }

    public enum ConditionType
    {
        FieldComparison = 1,
        RowCount = 2,
        RegexMatch = 3,
        Expression = 4
    }

    public enum ComparisonOperator
    {
        Equals = 1,
        NotEquals = 2,
        GreaterThan = 3,
        GreaterThanOrEqual = 4,
        LessThan = 5,
        LessThanOrEqual = 6,
        Contains = 7,
        DoesNotContain = 8,
        IsNull = 9,
        IsNotNull = 10
    }

    public enum LogicalOperator
    {
        And = 1,
        Or = 2
    }

    public enum ActionType
    {
        SetVisible = 1,
        SetRequired = 2,
        ShowMessage = 3,
        Block = 4,
        CreateRecord = 5,
        UpdateRecord = 6,
        DeleteRecord = 7,
        DeactivateRecord = 8   // appended: writes statecode = 1 and a status reason (never renumber)
    }

    /// <summary>The record-write operation a write-action performs.</summary>
    public enum WriteOperation
    {
        Create = 1,
        Update = 2,
        Delete = 3
    }

    public enum ActionFireOn
    {
        OnMatch = 1,
        OnNoMatch = 2
    }

    public enum Severity
    {
        Information = 1,
        Warning = 2,
        Error = 3
    }

    /// <summary>Execution contexts a rule can be tagged for (multi-select asx_triggers).</summary>
    public enum RuleTrigger
    {
        OnCreate = 1,
        OnForm = 2,
        OnDemand = 3,          // was Manual; runs without a save (asx_ApplyRules, Rule Runs, dry runs)
        OnUpdate = 4,
        OnDelete = 5
    }

    /// <summary>asx_rule.asx_ondemandscope: what an On demand rule runs for.</summary>
    public enum OnDemandScope
    {
        GivenRecord = 1,   // a record it's given (default)
        AllRecords = 2     // all records that pass its execution conditions
    }

    /// <summary>asx_rulerun.asx_status.</summary>
    public enum RuleRunStatus
    {
        Queued = 1,
        Running = 2,
        Completed = 3,
        CompletedWithFailures = 4,
        Failed = 5,
        Cancelled = 6
    }

    /// <summary>Where a condition's right-hand comparand comes from.</summary>
    public enum ComparisonValueSource
    {
        Literal = 1,        // asx_comparisonvalue (default, back-compat)
        FieldReference = 2, // a column on a single-cardinality node (own/root/lookup-chain)
        Template = 3,       // asx_comparisonvalue holds a {root.x}/{node:guid.x} template string
        DateExpression = 4  // asx_comparisonvalue holds a dateexpr JSON payload (anchor/op/amount/unit)
    }

    /// <summary>
    /// Origin channel a rule can be gated to (multi-select asx_channels). Two values only:
    /// Dataverse does not reliably tell a human apart from an integration (an interactive
    /// session can present an application id), so the engine
    /// keys on the one signal the platform guarantees, IsPortalsClientCall. Value 3
    /// ("Application") is retired; ChannelFilter reads a stored 3 as Standard.
    /// </summary>
    public enum RuleChannel
    {
        Standard = 1,  // every non-portal origin: model-driven apps, Web API, integrations, service principals, SYSTEM/async
        Portal = 2     // Power Pages (IsPortalsClientCall)
    }

    /// <summary>Rule lifecycle, mapped to the asx_rule statuscode reasons.</summary>
    public enum RuleStatus
    {
        Draft = 1,            // Active state, default reason. Never enforced (author WIP)
        Published = 753840000, // Active state. The only enforced status
        Archived = 2          // Inactive state. Retired, never enforced
    }

    /// <summary>Security context a rule's business-data traversal runs in. Per-rule; honored by plugin and API.</summary>
    public enum RuleEvaluationContext
    {
        User = 1,    // traversal runs in the caller's context (respects record visibility). The default
        System = 2   // traversal runs as system (deterministic, complete). Opt-in for integrity rules
    }

    /// <summary>asx_ruleschedule.asx_pattern: how a schedule's next run is computed.</summary>
    public enum SchedulePattern
    {
        EveryMinutes = 1,
        EveryHours = 2,
        Daily = 3,
        Weekly = 4,
        Monthly = 5
    }

    /// <summary>asx_ruleschedule.asx_lastoutcome: what happened the last time a schedule became due.</summary>
    public enum ScheduleOutcome
    {
        StartedRun = 1,
        ContinuedRun = 2,
        RuleNotRunnable = 3
    }
}
