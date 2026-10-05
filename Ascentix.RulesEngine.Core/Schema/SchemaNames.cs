namespace Ascentix.RulesEngine.Schema
{
    /// <summary>
    /// Single source of truth for the Ascentix Rules Engine schema's
    /// logical-name fragments (the part after the prefix). The engine binds to
    /// these logical names; keep them in sync with docs/Schema.md and the
    /// Dataverse environment.
    ///
    /// Fragments are prefix-agnostic. Call <see cref="Qualify(string,string)"/>
    /// with an explicit prefix, or <see cref="Qualify(string)"/> to use
    /// <see cref="DefaultPrefix"/> (the shipped build's prefix; the engine uses this).
    /// </summary>
    public static class SchemaNames
    {
        /// <summary>Prefix of the shipped Ascentix build. Fork-friendly single point of change.</summary>
        public const string DefaultPrefix = "asx";

        /// <summary>Primary name column fragment shared by every table.</summary>
        public const string PrimaryName = "name";

        public static string Qualify(string prefix, string fragment) => prefix + "_" + fragment;
        public static string Qualify(string fragment) => Qualify(DefaultPrefix, fragment);

        /// <summary>Logical name of a table's primary key column: {prefix}_{entity}id.</summary>
        public static string PrimaryId(string prefix, string entityFragment) => prefix + "_" + entityFragment + "id";

        public static class OptionSets
        {
            public const string LogicalOperator = "logicaloperator";
            public const string TableConfigType = "tableconfigtype";
            public const string ConditionType = "conditiontype";
            public const string ComparisonOperator = "comparisonoperator";
            public const string Severity = "severity";
            public const string ActionType = "actiontype";
            public const string ActionFireOn = "actionfireon";
            public const string Triggers = "triggers";
            public const string ComparisonValueSource = "comparisonvaluesource";
            public const string Channel = "channel";
            public const string EvaluationContext = "evaluationcontext";
            public const string CriterionType = "criteriontype";
        }

        public static class Rule
        {
            public const string Entity = "rule";
            public const string TableLogicalName = "tablelogicalname";
            public const string Triggers = "triggers";
            public const string Channels = "channels";
            public const string EffectiveFrom = "effectivefrom";
            public const string EffectiveTo = "effectiveto";
            public const string EvaluationContext = "evaluationcontext";
            public const string EvaluationTimeZone = "evaluationtimezone"; // Windows time zone id for date comparisons; blank = UTC
            public const string RootTableConfig = "roottableconfig";       // lookup → tableconfig (root node of the rule's shareable tree)
            public const string TriggerColumns = "triggercolumns";        // JSON array of root-table column logical names that fire OnUpdate
            public const string PublishedRevision = "publishedrevision";
            public const string PublishedVersion = "publishedversion";
            public const string PublishHash = "publishhash";
            public const string DraftStamp = "draftstamp";
            public const string DraftOf = "draftof";
            public const string DraftBaseVersion = "draftbaseversion";
            public const string OnDemandScope = "ondemandscope";
        }

        public static class RuleRevision
        {
            public const string Entity = "rulerevision";
            public const string Rule = "rule";
            public const string Version = "version";
            public const string Definition = "definition";
            public const string Hash = "hash";
            public const string Publisher = "publisher";
            public const string PublishedOn = "publishedon";
        }

        public static class PublicationLock
        {
            public const string Entity = "publicationlock";
        }

        /// <summary>An On demand run: one rule, processed page by page via asx_ProcessRunPage.</summary>
        public static class RuleRun
        {
            public const string Entity = "rulerun";
            public const string Name = "name";
            public const string Rule = "rule";                  // lookup → rule
            public const string Scope = "scope";                // asx_ondemandscope
            public const string RecordIds = "recordids";
            public const string Status = "status";              // asx_rulerunstatus
            public const string Evaluated = "evaluated";
            public const string Changed = "changed";
            public const string Blocked = "blocked";
            public const string Failed = "failed";
            public const string Skipped = "skipped";
            public const string Failures = "failures";
            public const string Bookmark = "bookmark";
            public const string RuleVersions = "ruleversions";
            public const string StartedOn = "startedon";
            public const string LastPageOn = "lastpageon";
            public const string FinishedOn = "finishedon";
        }

        /// <summary>A rule's recurring schedule: when it next becomes due, in the rule's time zone.</summary>
        public static class RuleSchedule
        {
            public const string Entity = "ruleschedule";
            public const string Name = "name";
            public const string Rule = "rule";                  // lookup → rule
            public const string On = "on";                      // whether the schedule is enabled
            public const string Pattern = "pattern";            // asx_schedulepattern
            public const string Every = "every";                // EveryMinutes/EveryHours: the N
            public const string TimeOfDay = "timeofday";        // Daily/Weekly/Monthly: "HH:mm"
            public const string DaysOfWeek = "daysofweek";      // Weekly: multi-select, 0-6 = System.DayOfWeek
            public const string DayOfMonth = "dayofmonth";      // Monthly: 1-31 (clamped to the month's last day)
            public const string NextRunOn = "nextrunon";        // UTC instant this schedule next becomes due
            public const string LastRunOn = "lastrunon";        // UTC instant this schedule last became due
            public const string LastRun = "lastrun";            // lookup → rulerun started for the last due instant
            public const string LastOutcome = "lastoutcome";    // asx_scheduleoutcome
        }

        /// <summary>Heartbeat/coordination row for the scheduler add-on's polling calls.</summary>
        public static class SchedulerStatus
        {
            public const string Entity = "schedulerstatus";
            public const string Name = "name";
            public const string LastSeenOn = "lastseenon";
            public const string LastSeenBy = "lastseenby";
            public const string CallsToday = "callstoday";
        }

        /// <summary>Opt-in diagnostics for form saves: one row per saved record while the
        /// CaptureDiagnostics environment variable is on. Timings, counts and ids only.</summary>
        public static class RuleDiagnostic
        {
            public const string Entity = "rulediagnostic";
            public const string Name = "name";                          // "<table> <message>"
            public const string TableLogicalName = "tablelogicalname";
            public const string RecordId = "recordid";                  // the saved record's id, "D" format
            public const string MessageName = "messagename";
            public const string CorrelationId = "correlationid";        // the save's correlation id, "D" format
            public const string Diagnostics = "diagnostics";            // full RunDiagnostics JSON (uncapped)
        }

        /// <summary>Environment variable schema-name fragments, qualified like tables and columns
        /// (asx_CaptureDiagnostics). An environment variable's schema name keeps its case.</summary>
        public static class EnvironmentVariables
        {
            /// <summary>Boolean, default false: form saves write asx_rulediagnostic rows while it is true.</summary>
            public const string CaptureDiagnostics = "CaptureDiagnostics";
        }

        public static class TableConfig
        {
            public const string IsPrivate = "isprivate";
            public const string Entity = "tableconfig";
            public const string TableLogicalName = "tablelogicalname";
            public const string TableConfigType = "tableconfigtype";
            public const string ParentTable = "parenttable";            // lookup → tableconfig
            public const string LookupColumnLogicalName = "lookupcolumnlogicalname";
            public const string ChildLinkField = "childlinkfield";
            public const string LookupTargetIdAttribute = "lookuptargetidattribute"; // LookupTable nodes: target table's primary-id attribute (for batched IN-query)
        }

        public static class ConditionGroup
        {
            public const string Entity = "conditiongroup";
            public const string Rule = "rule";                          // lookup → rule
            public const string ParentConditionGroup = "parentconditiongroup"; // lookup → conditiongroup
            public const string LogicalOperator = "logicaloperator";
            public const string IsExecutionCondition = "isexecutioncondition";
        }

        public static class RuleCondition
        {
            public const string Entity = "rulecondition";
            public const string ConditionGroup = "conditiongroup";      // lookup → conditiongroup
            public const string TableConfig = "tableconfig";            // lookup → tableconfig
            public const string ConditionType = "conditiontype";
            public const string ComparisonColumn = "comparisoncolumn";
            public const string ComparisonOperator = "comparisonoperator";
            public const string ComparisonValue = "comparisonvalue";
            public const string MinExpectedRows = "minexpectedrows";
            public const string MaxExpectedRows = "maxexpectedrows";
            public const string ComparisonValueSource = "comparisonvaluesource";
            public const string ComparisonValueNode = "comparisonvaluenode";   // lookup → tableconfig
            public const string ComparisonValueColumn = "comparisonvaluecolumn";
            public const string ConditionExpression = "conditionexpression";   // Expression condition: LHS mathexpr
            public const string ExpressionFilters = "expressionfilters";         // Expression condition: aggregate filters map (JSON)
        }

        public static class SearchCriteriaGroup
        {
            public const string Entity = "searchcriteriagroup";
            public const string RuleCondition = "rulecondition";        // lookup → rulecondition
            public const string ParentCriteriaGroup = "parentcriteriagroup"; // lookup → searchcriteriagroup
            public const string LogicalOperator = "logicaloperator";
        }

        public static class SearchCriterion
        {
            public const string Entity = "searchcriterion";
            public const string CriteriaGroup = "criteriagroup";        // lookup → searchcriteriagroup
            public const string FieldName = "fieldname";
            public const string Operator = "operator";
            public const string Value = "value";
        }

        public static class NodeFilterGroup
        {
            public const string Entity = "nodefiltergroup";
            public const string ConditionGroup = "conditiongroup";      // lookup → conditiongroup
            public const string TableConfigNode = "tableconfignode";    // lookup → tableconfig
            public const string ParentFilterGroup = "parentfiltergroup"; // lookup → nodefiltergroup
            public const string LogicalOperator = "logicaloperator";
            public const string RuleCondition = "rulecondition";        // lookup → rulecondition (owning condition)
            public const string OwningCriterion = "owningcriterion";    // lookup → nodefiltercriterion (Exists sub-filter root)
            public const string RuleAction = "ruleaction";              // lookup → ruleaction (the action's Rows filter)
        }

        public static class NodeFilterCriterion
        {
            public const string Entity = "nodefiltercriterion";
            public const string FilterGroup = "filtergroup";            // lookup → nodefiltergroup
            public const string FieldName = "fieldname";
            public const string Operator = "operator";
            public const string Value = "value";
            public const string ComparisonValueSource = "comparisonvaluesource";
            public const string ComparisonValueNode = "comparisonvaluenode"; // lookup → tableconfig
            public const string ComparisonValueColumn = "comparisonvaluecolumn";
            public const string CriterionType = "criteriontype";
            public const string CollectionNode = "collectionnode";      // lookup → tableconfig (Exists target)
            public const string MinCount = "mincount";
            public const string MaxCount = "maxcount";
        }

        public static class RuleAction
        {
            public const string Entity = "ruleaction";
            public const string Rule = "rule";                          // lookup → rule
            public const string ActionType = "actiontype";
            public const string FireOn = "fireon";
            public const string TargetColumn = "targetcolumn";
            public const string ValueBool = "valuebool";
            public const string ApplyInverseWhenNotFired = "applyinversewhennotfired";
            public const string Message = "message";
            public const string Severity = "severity";
            public const string TargetTable = "targettable";
            public const string TargetNode = "targetnode";              // lookup → tableconfig
            public const string FieldMapping = "fieldmapping";
            public const string Order = "order";
            public const string IsActive = "isactive";
            public const string ApplyToPrevious = "applytoprevious";   // Update Record: also run for the previous value of a changed lookup
        }

        public static class LocalizedMessage
        {
            public const string Entity = "localizedmessage";
            public const string RuleAction = "ruleaction";       // lookup → ruleaction
            public const string LanguageCode = "languagecode";   // whole number (LCID)
            public const string Message = "message";
        }

        // -----------------------------------------------------------------------
        // Custom API contracts
        // These mirror what is registered in the Dataverse environment; the
        // plugin handlers bind to these string constants for InputParameters /
        // OutputParameters access. Keep in sync with docs/Schema.md §5.
        // -----------------------------------------------------------------------

        /// <summary>
        /// asx_ValidateRule: unbound Action that validates a persisted rule and
        /// returns a structured report. Non-enforcing: an invalid rule is returned
        /// as data, never thrown. Handler: ValidateRuleApi.
        /// </summary>
        public static class ValidateRuleApi
        {
            /// <summary>Custom API message / unique name (registered in Dataverse).</summary>
            public const string MessageName = "ValidateRule";       // full: asx_ValidateRule

            // Input parameter: must equal InputParameters key the handler reads.
            public const string ParamRuleId = "RuleId";

            // Output parameters: must equal OutputParameters keys the handler writes.
            public const string PropIsValid = "IsValid";
            public const string PropIssues  = "Issues";
        }

        /// <summary>
        /// asx_ApplyRules: unbound Action that evaluates one On demand rule against one record
        /// and enforces it: a fired Block throws; otherwise the rule's fired writes are applied.
        /// </summary>
        public static class ApplyRulesApi
        {
            /// <summary>Custom API message / unique name (registered in Dataverse).</summary>
            public const string MessageName = "ApplyRules";       // full: asx_ApplyRules

            // Input parameters: must equal InputParameters keys the handler reads.
            public const string ParamRuleId = "RuleId";
            public const string ParamRecordId = "RecordId";
            /// <summary>Optional Boolean input: when true, the response carries Diagnostics.</summary>
            public const string ParamIncludeDiagnostics = "IncludeDiagnostics";

            // Output parameters: must equal OutputParameters keys the handler writes.
            public const string PropIsValid = "IsValid";
            public const string PropResults = "Results";
            public const string PropWriteCount = "WriteCount";
            /// <summary>String output, set only when IncludeDiagnostics is true: RunDiagnostics JSON.</summary>
            public const string PropDiagnostics = "Diagnostics";
        }

        /// <summary>
        /// asx_ProcessRunPage: unbound Action that advances one Rule Run by a page of records.
        /// </summary>
        public static class ProcessRunPageApi
        {
            /// <summary>Custom API message / unique name (registered in Dataverse).</summary>
            public const string MessageName = "ProcessRunPage";   // full: asx_ProcessRunPage

            // Input parameters: must equal InputParameters keys the handler reads.
            public const string ParamRunId = "RunId";
            public const string ParamFailedRecordId = "FailedRecordId";
            public const string ParamFailedMessage = "FailedMessage";
            /// <summary>Optional Boolean input: when true, the response carries Diagnostics.</summary>
            public const string ParamIncludeDiagnostics = "IncludeDiagnostics";

            // Output parameters: must equal OutputParameters keys the handler writes.
            public const string PropDone = "Done";
            public const string PropStatus = "Status";
            public const string PropEvaluated = "Evaluated";
            public const string PropChanged = "Changed";
            public const string PropBlocked = "Blocked";
            public const string PropFailed = "Failed";
            public const string PropSkipped = "Skipped";
            /// <summary>String output, set only when IncludeDiagnostics is true: RunDiagnostics JSON.</summary>
            public const string PropDiagnostics = "Diagnostics";
        }

        /// <summary>
        /// asx_StartDueSchedules: unbound Action the scheduler add-on calls on a timer to start
        /// (or continue) every due Rule Schedule.
        /// </summary>
        public static class StartDueSchedulesApi
        {
            /// <summary>Custom API message / unique name (registered in Dataverse).</summary>
            public const string MessageName = "StartDueSchedules";   // full: asx_StartDueSchedules

            // Input parameters: must equal InputParameters keys the handler reads.
            /// <summary>Optional Boolean input: when true, the response carries Diagnostics.</summary>
            public const string ParamIncludeDiagnostics = "IncludeDiagnostics";

            // Output parameters: must equal OutputParameters keys the handler writes.
            public const string PropRunIds = "RunIds";
            public const string PropScheduledCount = "ScheduledCount";
            /// <summary>String output, set only when IncludeDiagnostics is true: RunDiagnostics JSON.</summary>
            public const string PropDiagnostics = "Diagnostics";
        }

        /// <summary>
        /// One row per release data update that has started (docs/Schema.md §2.18). Written only by
        /// asx_ApplyDataUpdates; the row id is fixed per update number (DataUpdateRows.RowId).
        /// </summary>
        public static class DataUpdate
        {
            public const string Entity = "dataupdate";
            public const string Name = "name";                // the update's title
            public const string Number = "number";
            public const string Status = "status";            // local choice: Running 1, Completed 2, Completed with failures 3, Failed 4
            public const string Cursor = "cursor";
            public const string Succeeded = "succeeded";
            public const string Failed = "failed";
            public const string Failures = "failures";
            public const string StartedOn = "startedon";
            public const string CompletedOn = "completedon";
            public const string LastPageOn = "lastpageon";
            public const string RunBy = "runby";              // lookup → systemuser
        }

        /// <summary>
        /// asx_ApplyDataUpdates: unbound Action that reports (Mode = Status) or applies (Mode = Apply)
        /// the data updates this release carries (docs/Schema.md §10).
        /// </summary>
        public static class ApplyDataUpdatesApi
        {
            /// <summary>Custom API message / unique name (registered in Dataverse).</summary>
            public const string MessageName = "ApplyDataUpdates";   // full: asx_ApplyDataUpdates

            // Input parameters: must equal InputParameters keys the handler reads.
            public const string ParamMode = "Mode";
            public const string ParamRetry = "Retry";
            public const string ParamFailedItem = "FailedItem";
            public const string ParamFailedMessage = "FailedMessage";

            // Output parameters: must equal OutputParameters keys the handler writes.
            public const string PropRequired = "Required";
            public const string PropPending = "Pending";
            public const string PropLatest = "Latest";
            public const string PropCanApply = "CanApply";
            public const string PropDone = "Done";
        }

        /// <summary>Relationship (schema) name fragments.</summary>
        public static class Relationships
        {
            public const string RuleConditionGroup = "rule_conditiongroup";
            public const string RuleRootTableConfig = "rule_roottableconfig";
            public const string ConditionGroupConditionGroup = "conditiongroup_conditiongroup";
            public const string ConditionGroupCondition = "conditiongroup_condition";
            public const string ConditionGroupNodeFilterGroup = "conditiongroup_nodefiltergroup";
            public const string TableConfigTableConfig = "tableconfig_tableconfig";
            public const string ConditionTableConfig = "condition_tableconfig";
            public const string ConditionCriteriaGroup = "condition_criteriagroup";
            public const string CriteriaGroupCriteriaGroup = "criteriagroup_criteriagroup";
            public const string CriteriaGroupCriterion = "criteriagroup_criterion";
            public const string NodeFilterGroupNodeFilterGroup = "nodefiltergroup_nodefiltergroup";
            public const string NodeFilterGroupCriterion = "nodefiltergroup_criterion";
            public const string NodeFilterGroupTableConfig = "nodefiltergroup_tableconfig";
            public const string RuleRuleAction = "rule_ruleaction";
            public const string ConditionComparisonValueNode = "condition_comparisonvaluenode";
            public const string RuleActionLocalizedMessage = "ruleaction_localizedmessage";
            public const string RuleConditionNodeFilterGroup = "rulecondition_nodefiltergroup";
            public const string NodeFilterCriterionComparisonValueNode = "nodefiltercriterion_comparisonvaluenode";
            public const string NodeFilterCriterionCollectionNode = "nodefiltercriterion_collectionnode";
            public const string NodeFilterGroupOwningCriterion = "nodefiltergroup_owningcriterion";
            public const string RuleActionNodeFilterGroup = "ruleaction_nodefiltergroup";
        }
    }
}
