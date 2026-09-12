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
            public const string RootTableConfig = "roottableconfig";       // lookup → tableconfig (root node of the rule's shareable tree)
            public const string TriggerColumns = "triggercolumns";        // JSON array of root-table column logical names that fire OnUpdate
            public const string PublishedRevision = "publishedrevision";
            public const string PublishedVersion = "publishedversion";
            public const string PublishHash = "publishhash";
            public const string DraftStamp = "draftstamp";
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

        public static class TableConfig
        {
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
        }
    }
}
