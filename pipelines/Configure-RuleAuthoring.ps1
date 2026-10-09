<# Provision authoring metadata in the maintainer environment for managed-solution export. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Schema','Register')][string]$Phase,
    [Parameter(Mandatory)][string]$EnvUrl,
    [Parameter(Mandatory)][string]$AccessToken,
    [string]$SolutionName = 'AscentixRulesEngine',
    [string]$AssemblyName = 'Ascentix.RulesEngine.Plugin'
)
$ErrorActionPreference = 'Stop'
$base = $EnvUrl.TrimEnd('/') + '/api/data/v9.2'
$headers = @{ Authorization = "Bearer $AccessToken"; Accept = 'application/json';
    'OData-Version' = '4.0'; 'OData-MaxVersion' = '4.0'; 'MSCRM.SolutionUniqueName' = $SolutionName }
function Request([string]$Method, [string]$Path, $Body = $null, [hashtable]$ExtraHeaders = $null) {
    $sent = if ($ExtraHeaders) { $headers + $ExtraHeaders } else { $headers }
    $args0 = @{ Method = $Method; Uri = "$base/$Path"; Headers = $sent }
    if ($null -ne $Body) { $args0.ContentType = 'application/json'; $args0.Body = $Body | ConvertTo-Json -Depth 30 -Compress }
    try { Invoke-RestMethod @args0 }
    catch {
        Write-Warning "[revisions] $Phase request failed: $Method $Path"
        throw
    }
}
function Label([string]$Text) { @{ LocalizedLabels = @(@{ Label = $Text; LanguageCode = 1033 }) } }
function Field([string]$Name, [string]$Type, [string]$Display) {
    @{ '@odata.type' = "Microsoft.Dynamics.CRM.${Type}AttributeMetadata"; SchemaName = $Name;
        DisplayName = (Label $Display); RequiredLevel = @{ Value = 'None' }; IsAuditEnabled = @{ Value = $false } }
}
function EnsureField([string]$Table, $Definition) {
    $logical = $Definition.SchemaName.ToLowerInvariant()
    $existing = Request GET "EntityDefinitions(LogicalName='$Table')/Attributes?`$select=LogicalName&`$filter=LogicalName eq '$logical'"
    if ($existing.value.Count -eq 0) { Request POST "EntityDefinitions(LogicalName='$Table')/Attributes" $Definition | Out-Null }
}
# Seconds between metadata polls; a caller (the offline test) may set $MetadataPollSeconds first.
$script:MetadataPollSeconds = if ($null -ne $MetadataPollSeconds) { [int]$MetadataPollSeconds } else { 5 }
# A just-created table can answer "does not exist" for a while; wait until its attributes can be read.
# Calls Invoke-RestMethod directly so Request's failure warning is not printed on every poll.
function WaitForTable([string]$Table, [int]$TimeoutSeconds = 120) {
    $attempts = [math]::Max(1, [math]::Ceiling($TimeoutSeconds / [math]::Max(1, $script:MetadataPollSeconds)))
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        try {
            Invoke-RestMethod -Method GET -Uri "$base/EntityDefinitions(LogicalName='$Table')/Attributes?`$select=LogicalName&`$top=1" -Headers $headers | Out-Null
            return
        }
        catch {
            $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
            $text = "$($_.ErrorDetails.Message) $($_.Exception.Message)"
            if ($status -ne 404 -and $text -notmatch 'does not exist|Could not find') { throw }
        }
        if ($attempt -lt $attempts) { Start-Sleep -Seconds $script:MetadataPollSeconds }
    }
    throw "Table $Table was created but is still not visible after $TimeoutSeconds seconds; wait a few minutes and run the Schema phase again."
}
function EnsureTable([string]$Name, [string]$Display, [string]$Ownership = 'OrganizationOwned', [string]$EntitySetName = '') {
    $logical = $Name.ToLowerInvariant()
    $setName = if ($EntitySetName) { $EntitySetName } else { $logical + 's' }
    $existing = Request GET "EntityDefinitions?`$select=LogicalName,EntitySetName,MetadataId&`$filter=LogicalName eq '$logical'"
    if ($existing.value.Count -gt 0) {
        # An explicit set name converges an existing table created under the default one; the
        # PublishXml at the end of the phase publishes it.
        $table = @($existing.value)[0]
        if ($EntitySetName -and $table.EntitySetName -cne $EntitySetName) {
            $current = Request GET "EntityDefinitions($($table.MetadataId))"
            $definition = [ordered]@{ '@odata.type' = 'Microsoft.Dynamics.CRM.EntityMetadata' }
            foreach ($property in $current.PSObject.Properties) {
                if (!$property.Name.StartsWith('@odata.')) { $definition[$property.Name] = $property.Value }
            }
            $definition.EntitySetName = $EntitySetName
            Request PUT "EntityDefinitions($($table.MetadataId))" $definition @{ 'MSCRM.MergeLabels' = 'true' } | Out-Null
        }
        return
    }
    $primary = Field 'asx_Name' 'String' 'Name'; $primary.MaxLength = 200; $primary.IsPrimaryName = $true
    $primary.FormatName = @{ Value = 'Text' }
    Request POST 'EntityDefinitions' @{
        '@odata.type' = 'Microsoft.Dynamics.CRM.EntityMetadata'; SchemaName = $Name; EntitySetName = $setName;
        DisplayName = (Label $Display); DisplayCollectionName = (Label ($Display + 's'));
        OwnershipType = $Ownership; HasActivities = $false; HasNotes = $false;
        IsActivity = $false; IsAuditEnabled = @{ Value = $false }; Attributes = @($primary)
    } | Out-Null
    WaitForTable $logical
}
function EnsureOptionLabel([string]$OptionSet, [int]$Value, [string]$Text) {
    $definition = Request GET "GlobalOptionSetDefinitions(Name='$OptionSet')/Microsoft.Dynamics.CRM.OptionSetMetadata?`$select=Options"
    $option = $definition.Options | Where-Object { $_.Value -eq $Value }
    $current = ($option.Label.LocalizedLabels | Where-Object { $_.LanguageCode -eq 1033 }).Label
    if ($current -ne $Text) {
        Request POST 'UpdateOptionValue' @{ OptionSetName = $OptionSet; Value = $Value; Label = (Label $Text); MergeLabels = $true } | Out-Null
    }
}
# Appends an option to a global choice (never renumbers), or relabels it when it exists.
function EnsureOptionValue([string]$OptionSet, [int]$Value, [string]$Text) {
    $definition = Request GET "GlobalOptionSetDefinitions(Name='$OptionSet')/Microsoft.Dynamics.CRM.OptionSetMetadata?`$select=Options"
    if (@($definition.Options | Where-Object { $_.Value -eq $Value }).Count -gt 0) { EnsureOptionLabel $OptionSet $Value $Text; return }
    Request POST 'InsertOptionValue' @{ OptionSetName = $OptionSet; Value = $Value; Label = (Label $Text); SolutionUniqueName = $SolutionName } | Out-Null
}
function EnsureLookup([string]$From, [string]$To, [string]$Name, [string]$Display, [string]$Delete = 'Restrict', [string]$Relationship = '') {
    $logical = $Name.ToLowerInvariant()
    $existing = Request GET "EntityDefinitions(LogicalName='$From')/Attributes?`$select=LogicalName&`$filter=LogicalName eq '$logical'"
    if ($existing.value.Count -gt 0) {
        $relations = Request GET "EntityDefinitions(LogicalName='$From')/ManyToOneRelationships?`$select=MetadataId,SchemaName,CascadeConfiguration&`$filter=ReferencingAttribute eq '$logical'"
        foreach ($relation in $relations.value) {
            if ($relation.CascadeConfiguration.Delete -eq $Delete) { continue }
            $relation.CascadeConfiguration.Delete = $Delete
            Request PUT "RelationshipDefinitions($($relation.MetadataId))" @{
                '@odata.type' = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata';
                MetadataId = $relation.MetadataId; SchemaName = $relation.SchemaName; CascadeConfiguration = $relation.CascadeConfiguration
            } | Out-Null
        }
        return
    }
    Request POST 'RelationshipDefinitions' @{
        '@odata.type' = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'; SchemaName = $(if ($Relationship) { $Relationship } else { "${From}_${logical}_revision" });
        ReferencedEntity = $To; ReferencingEntity = $From; Lookup = (Field $Name 'Lookup' $Display);
        CascadeConfiguration = @{ Assign = 'NoCascade'; Delete = $Delete; Merge = 'NoCascade'; Reparent = 'NoCascade'; Share = 'NoCascade'; Unshare = 'NoCascade' }
    } | Out-Null
}
# Creates an environment variable definition in the solution (the header names it) with its default
# and no value row; an existing definition is left as it is, including any value set on it.
function EnsureEnvironmentVariableDefinition([string]$SchemaName, [string]$Display, [int]$Type, [string]$Default, [string]$Description) {
    $existing = Request GET "environmentvariabledefinitions?`$select=environmentvariabledefinitionid&`$filter=schemaname eq '$SchemaName'"
    if ($existing.value.Count -gt 0) { return }
    Request POST 'environmentvariabledefinitions' @{ schemaname = $SchemaName; displayname = $Display; description = $Description;
        type = $Type; defaultvalue = $Default } | Out-Null
}

if ($Phase -eq 'Schema') {
    EnsureTable 'asx_RuleRevision' 'Rule Revision'
    EnsureTable 'asx_PublicationLock' 'Publication Lock'
    foreach ($spec in @(@('asx_rulerevision','asx_Definition',1000000), @('asx_rulerevision','asx_Hash',64),
        @('asx_rule','asx_PublishHash',64), @('asx_rule','asx_DraftStamp',36))) {
        $type = if ([int]$spec[2] -gt 4000) { 'Memo' } else { 'String' }
        $field = Field $spec[1] $type $spec[1]; $field.MaxLength = [int]$spec[2]
        EnsureField $spec[0] $field
    }
    foreach ($spec in @(@('asx_rule','asx_PublishedVersion'), @('asx_rule','asx_DraftBaseVersion'), @('asx_rulerevision','asx_Version'))) {
        $field = Field $spec[1] 'Integer' 'Published version'; $field.MinValue = 0; $field.MaxValue = 2147483647
        EnsureField $spec[0] $field
    }
    $date = Field 'asx_PublishedOn' 'DateTime' 'Published on'; $date.Format = 'DateAndTime'; $date.DateTimeBehavior = @{ Value = 'UserLocal' }
    EnsureField 'asx_rulerevision' $date
    EnsureLookup 'asx_rulerevision' 'asx_rule' 'asx_Rule' 'Rule' 'RemoveLink'
    EnsureLookup 'asx_rulerevision' 'systemuser' 'asx_Publisher' 'Publisher'
    EnsureLookup 'asx_rule' 'asx_rulerevision' 'asx_PublishedRevision' 'Published revision' 'RemoveLink'
    EnsureLookup 'asx_rule' 'asx_rule' 'asx_DraftOf' 'Working draft of' 'RemoveLink'
    $private = Field 'asx_IsPrivate' 'Boolean' 'Private rule model'
    $private.DefaultValue = $false
    $private.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata';
        TrueOption = @{ Value = 1; Label = (Label 'Yes') }; FalseOption = @{ Value = 0; Label = (Label 'No') } }
    EnsureField 'asx_tableconfig' $private
    $expressionFilters = Field 'asx_ExpressionFilters' 'Memo' 'Expression filters'; $expressionFilters.MaxLength = 100000
    EnsureField 'asx_rulecondition' $expressionFilters
    $timeZone = Field 'asx_EvaluationTimeZone' 'String' 'Evaluation time zone'; $timeZone.MaxLength = 100
    EnsureField 'asx_rule' $timeZone
    $applyPrevious = Field 'asx_ApplyToPrevious' 'Boolean' 'Also apply to previous'
    $applyPrevious.DefaultValue = $false
    $applyPrevious.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata';
        TrueOption = @{ Value = 1; Label = (Label 'Yes') }; FalseOption = @{ Value = 0; Label = (Label 'No') } }
    EnsureField 'asx_ruleaction' $applyPrevious
    EnsureTable 'asx_RuleRun' 'Rule Run' 'UserOwned'
    $scope = Field 'asx_Scope' 'Picklist' 'Scope'
    $scope.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label 'Given records') }, @{ Value = 2; Label = (Label 'All records') }) }
    EnsureField 'asx_rulerun' $scope
    $status = Field 'asx_Status' 'Picklist' 'Status'
    $status.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label 'Queued') }, @{ Value = 2; Label = (Label 'Running') }, @{ Value = 3; Label = (Label 'Completed') },
            @{ Value = 4; Label = (Label 'Completed with failures') }, @{ Value = 5; Label = (Label 'Failed') }, @{ Value = 6; Label = (Label 'Cancelled') }) }
    EnsureField 'asx_rulerun' $status
    foreach ($spec in @(@('asx_RecordIds', 'Record Ids', 20000), @('asx_Failures', 'Failures', 100000),
        @('asx_Bookmark', 'Bookmark', 100000), @('asx_RuleVersions', 'Rule Versions', 4000))) {
        $field = Field $spec[0] 'Memo' $spec[1]; $field.MaxLength = [int]$spec[2]
        EnsureField 'asx_rulerun' $field
    }
    foreach ($spec in @(@('asx_Evaluated', 'Evaluated'), @('asx_Changed', 'Changed'), @('asx_Blocked', 'Blocked'), @('asx_Failed', 'Failed'), @('asx_Skipped', 'Skipped'))) {
        $field = Field $spec[0] 'Integer' $spec[1]; $field.MinValue = 0; $field.MaxValue = 2147483647
        EnsureField 'asx_rulerun' $field
    }
    foreach ($spec in @(@('asx_StartedOn', 'Started On'), @('asx_LastPageOn', 'Last Page On'), @('asx_FinishedOn', 'Finished On'))) {
        $field = Field $spec[0] 'DateTime' $spec[1]; $field.Format = 'DateAndTime'; $field.DateTimeBehavior = @{ Value = 'UserLocal' }
        EnsureField 'asx_rulerun' $field
    }
    EnsureLookup 'asx_rulerun' 'asx_rule' 'asx_Rule' 'Rule' 'Cascade'
    $onDemandScope = Field 'asx_OnDemandScope' 'Picklist' 'Runs for'
    $onDemandScope.DefaultFormValue = 1
    $onDemandScope.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label "A record it's given") }, @{ Value = 2; Label = (Label 'All records that pass its execution conditions') }) }
    EnsureField 'asx_rule' $onDemandScope
    EnsureOptionLabel 'asx_triggers' 3 'On demand'
    EnsureTable 'asx_RuleSchedule' 'Rule Schedule'
    EnsureTable 'asx_SchedulerStatus' 'Scheduler Status' -EntitySetName 'asx_schedulerstatuses'
    $on = Field 'asx_On' 'Boolean' 'On'
    $on.DefaultValue = $true
    $on.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata';
        TrueOption = @{ Value = 1; Label = (Label 'Yes') }; FalseOption = @{ Value = 0; Label = (Label 'No') } }
    EnsureField 'asx_ruleschedule' $on
    $pattern = Field 'asx_Pattern' 'Picklist' 'Pattern'
    $pattern.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label 'Every N minutes') }, @{ Value = 2; Label = (Label 'Every N hours') },
            @{ Value = 3; Label = (Label 'Daily') }, @{ Value = 4; Label = (Label 'Weekly') }, @{ Value = 5; Label = (Label 'Monthly') }) }
    EnsureField 'asx_ruleschedule' $pattern
    $every = Field 'asx_Every' 'Integer' 'Every'; $every.MinValue = 1; $every.MaxValue = 59
    EnsureField 'asx_ruleschedule' $every
    $timeOfDay = Field 'asx_TimeOfDay' 'String' 'Time of day'; $timeOfDay.MaxLength = 5
    EnsureField 'asx_ruleschedule' $timeOfDay
    $daysOfWeek = Field 'asx_DaysOfWeek' 'MultiSelectPicklist' 'Days of week'
    $daysOfWeek.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 0; Label = (Label 'Sunday') }, @{ Value = 1; Label = (Label 'Monday') }, @{ Value = 2; Label = (Label 'Tuesday') },
            @{ Value = 3; Label = (Label 'Wednesday') }, @{ Value = 4; Label = (Label 'Thursday') }, @{ Value = 5; Label = (Label 'Friday') },
            @{ Value = 6; Label = (Label 'Saturday') }) }
    EnsureField 'asx_ruleschedule' $daysOfWeek
    $dayOfMonth = Field 'asx_DayOfMonth' 'Integer' 'Day of month'; $dayOfMonth.MinValue = 1; $dayOfMonth.MaxValue = 31
    EnsureField 'asx_ruleschedule' $dayOfMonth
    $nextRunOn = Field 'asx_NextRunOn' 'DateTime' 'Next run on'; $nextRunOn.Format = 'DateAndTime'; $nextRunOn.DateTimeBehavior = @{ Value = 'TimeZoneIndependent' }
    EnsureField 'asx_ruleschedule' $nextRunOn
    $lastRunOn = Field 'asx_LastRunOn' 'DateTime' 'Last run on'; $lastRunOn.Format = 'DateAndTime'; $lastRunOn.DateTimeBehavior = @{ Value = 'UserLocal' }
    EnsureField 'asx_ruleschedule' $lastRunOn
    $lastOutcome = Field 'asx_LastOutcome' 'Picklist' 'Last outcome'
    $lastOutcome.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label 'Started a run') }, @{ Value = 2; Label = (Label 'Continued the active run') }, @{ Value = 3; Label = (Label 'Rule not runnable') }) }
    EnsureField 'asx_ruleschedule' $lastOutcome
    EnsureLookup 'asx_ruleschedule' 'asx_rule' 'asx_Rule' 'Rule' 'Cascade'
    EnsureLookup 'asx_ruleschedule' 'asx_rulerun' 'asx_LastRun' 'Last run' 'RemoveLink'
    $lastSeenOn = Field 'asx_LastSeenOn' 'DateTime' 'Last seen on'; $lastSeenOn.Format = 'DateAndTime'; $lastSeenOn.DateTimeBehavior = @{ Value = 'UserLocal' }
    EnsureField 'asx_schedulerstatus' $lastSeenOn
    $callsToday = Field 'asx_CallsToday' 'Integer' 'Calls today'; $callsToday.MinValue = 0; $callsToday.MaxValue = 2147483647
    EnsureField 'asx_schedulerstatus' $callsToday
    EnsureLookup 'asx_schedulerstatus' 'systemuser' 'asx_LastSeenBy' 'Last seen by' 'RemoveLink'
    EnsureLookup 'asx_nodefiltergroup' 'asx_ruleaction' 'asx_RuleAction' 'Rule action' 'Cascade' 'asx_ruleaction_nodefiltergroup'
    # Multi-outcome actions (docs/Schema.md 2.18-2.19): an action's "Fires when" tree. Every node carries
    # asx_ruleaction (one query loads a whole tree); tests point at an outcome (a top-level validation group).
    EnsureTable 'asx_ActionConditionGroup' 'Action Condition Group' 'UserOwned'
    $op = Field 'asx_LogicalOperator' 'Picklist' 'Logical operator'
    $op.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label 'ALL') }, @{ Value = 2; Label = (Label 'ANY') }) }
    EnsureField 'asx_actionconditiongroup' $op
    $field = Field 'asx_Order' 'Integer' 'Order'; $field.MinValue = 0; $field.MaxValue = 2147483647
    EnsureField 'asx_actionconditiongroup' $field
    EnsureLookup 'asx_actionconditiongroup' 'asx_ruleaction' 'asx_RuleAction' 'Rule action' 'Cascade' 'asx_ruleaction_actionconditiongroup'
    EnsureLookup 'asx_actionconditiongroup' 'asx_actionconditiongroup' 'asx_ParentGroup' 'Parent group' 'RemoveLink' 'asx_actionconditiongroup_actionconditiongroup'

    EnsureTable 'asx_ActionConditionTest' 'Action Condition Test' 'UserOwned'
    # asx_Expected: true = "is true", false = "is false".
    $expected = Field 'asx_Expected' 'Boolean' 'Expected'
    $expected.DefaultValue = $true
    $expected.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata';
        TrueOption = @{ Value = 1; Label = (Label 'Is true') }; FalseOption = @{ Value = 0; Label = (Label 'Is false') } }
    EnsureField 'asx_actionconditiontest' $expected
    $field = Field 'asx_Order' 'Integer' 'Order'; $field.MinValue = 0; $field.MaxValue = 2147483647
    EnsureField 'asx_actionconditiontest' $field
    EnsureLookup 'asx_actionconditiontest' 'asx_actionconditiongroup' 'asx_ActionConditionGroup' 'Group' 'Cascade' 'asx_actionconditiongroup_actionconditiontest'
    EnsureLookup 'asx_actionconditiontest' 'asx_conditiongroup' 'asx_Outcome' 'Outcome' 'RemoveLink' 'asx_conditiongroup_actionconditiontest'
    EnsureOptionValue 'asx_actiontype' 8 'Deactivate Record'
    # Opt-in diagnostics for form saves: one row per saved record while asx_CaptureDiagnostics is on.
    EnsureTable 'asx_RuleDiagnostic' 'Rule Diagnostic'
    foreach ($spec in @(@('asx_TableLogicalName', 'Table logical name', 100), @('asx_RecordId', 'Record id', 36),
        @('asx_MessageName', 'Message name', 100), @('asx_CorrelationId', 'Correlation id', 36), @('asx_Diagnostics', 'Diagnostics', 1048576))) {
        $type = if ([int]$spec[2] -gt 4000) { 'Memo' } else { 'String' }
        $field = Field $spec[0] $type $spec[1]; $field.MaxLength = [int]$spec[2]
        EnsureField 'asx_rulediagnostic' $field
    }
    # Environment variable type Boolean = 100000002; Dataverse stores a Boolean value as yes/no.
    EnsureEnvironmentVariableDefinition 'asx_BulkWrites' 'Bulk writes' 100000002 'no' 'When yes, the rules engine sends two or more creates or updates of one table as CreateMultiple or UpdateMultiple. Faster, but Microsoft does not support bulk messages in plug-in code. When no, every write is a single request.'
    EnsureEnvironmentVariableDefinition 'asx_CaptureDiagnostics' 'Capture diagnostics' 100000002 'no' 'When yes, every form save the rules engine evaluates writes one Rule Diagnostic row per saved record with its timings and counts. Leave it at no outside a measurement.'
    # Data updates (docs/Schema.md §2.20): one row per release data update, written only by asx_ApplyDataUpdates.
    EnsureTable 'asx_DataUpdate' 'Data Update'
    $field = Field 'asx_Number' 'Integer' 'Number'; $field.MinValue = 0; $field.MaxValue = 2147483647
    EnsureField 'asx_dataupdate' $field
    $status = Field 'asx_Status' 'Picklist' 'Status'
    $status.OptionSet = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist';
        Options = @(@{ Value = 1; Label = (Label 'Running') }, @{ Value = 2; Label = (Label 'Completed') },
            @{ Value = 3; Label = (Label 'Completed with failures') }) }
    EnsureField 'asx_dataupdate' $status
    foreach ($spec in @(@('asx_Cursor', 'Cursor', 100000), @('asx_Failures', 'Failures', 100000))) {
        $field = Field $spec[0] 'Memo' $spec[1]; $field.MaxLength = [int]$spec[2]
        EnsureField 'asx_dataupdate' $field
    }
    foreach ($spec in @(@('asx_Succeeded', 'Succeeded'), @('asx_Failed', 'Failed'))) {
        $field = Field $spec[0] 'Integer' $spec[1]; $field.MinValue = 0; $field.MaxValue = 2147483647
        EnsureField 'asx_dataupdate' $field
    }
    foreach ($spec in @(@('asx_StartedOn', 'Started On'), @('asx_CompletedOn', 'Completed On'), @('asx_LastPageOn', 'Last Page On'))) {
        $field = Field $spec[0] 'DateTime' $spec[1]; $field.Format = 'DateAndTime'; $field.DateTimeBehavior = @{ Value = 'UserLocal' }
        EnsureField 'asx_dataupdate' $field
    }
    EnsureLookup 'asx_dataupdate' 'systemuser' 'asx_RunBy' 'Run by' 'RemoveLink'
    Request POST 'PublishXml' @{ ParameterXml = '<importexportxml><entities><entity>asx_rule</entity><entity>asx_rulerevision</entity><entity>asx_publicationlock</entity><entity>asx_tableconfig</entity><entity>asx_rulecondition</entity><entity>asx_ruleaction</entity><entity>asx_rulerun</entity><entity>asx_ruleschedule</entity><entity>asx_schedulerstatus</entity><entity>asx_rulediagnostic</entity><entity>asx_nodefiltergroup</entity><entity>asx_dataupdate</entity><entity>asx_actionconditiongroup</entity><entity>asx_actionconditiontest</entity></entities><optionsets><optionset>asx_triggers</optionset><optionset>asx_actiontype</optionset></optionsets></importexportxml>' } | Out-Null
    # Only configure the product's shipped views; personal/customer views are not selected.
    foreach ($spec in @(@('asx_rule','asx_draftof'), @('asx_tableconfig','asx_isprivate'))) {
        $viewFolder = Join-Path $PSScriptRoot "../Solutions/$SolutionName/${SolutionName}_unmanaged/Entities/$($spec[0])/SavedQueries"
        foreach ($file in Get-ChildItem -LiteralPath $viewFolder -Filter '*.xml') {
            [xml]$source = Get-Content -LiteralPath $file.FullName -Raw
            $id = ([string]$source.savedqueries.savedquery.savedqueryid).Trim('{}')
            $view = Request GET "savedqueries($id)?`$select=fetchxml,layoutxml,returnedtypecode,querytype,isquickfindquery"
            [xml]$fetch = $view.fetchxml
            $entity = $fetch.SelectSingleNode("/fetch/entity[@name='$($spec[0])']")
            if (!$entity) { throw "Unexpected entity in shipped view $id" }
            # Quick Find keeps its search filter separate from the single row-selection filter.
            $rowFilters = @($entity.SelectNodes("filter[not(@isquickfindfields='1' or @isquickfindfields='true')]"))
            $filter = if ($rowFilters.Count -eq 1 -and $rowFilters[0].GetAttribute('type') -ne 'or') { $rowFilters[0] } else { $null }
            if (!$filter -or !$filter.SelectSingleNode("condition[@attribute='$($spec[1])']")) {
                if (!$filter) {
                    $filter = $fetch.CreateElement('filter'); $filter.SetAttribute('type', 'and')
                    $firstFilter = $entity.SelectSingleNode('filter')
                    if ($firstFilter) { $entity.InsertBefore($filter, $firstFilter) | Out-Null }
                    else { $entity.AppendChild($filter) | Out-Null }
                    foreach ($existingFilter in $rowFilters) { $filter.AppendChild($existingFilter) | Out-Null }
                }
                $condition = $fetch.CreateElement('condition'); $condition.SetAttribute('attribute', $spec[1])
                if ($spec[0] -eq 'asx_rule') { $condition.SetAttribute('operator', 'null') }
                else { $condition.SetAttribute('operator', 'ne'); $condition.SetAttribute('value', '1') }
                $filter.AppendChild($condition) | Out-Null
                # Quick Find updates require the view definition context alongside FetchXML.
                Request PATCH "savedqueries($id)" @{
                    fetchxml = $fetch.OuterXml; layoutxml = $view.layoutxml; returnedtypecode = $view.returnedtypecode
                    querytype = $view.querytype; isquickfindquery = $view.isquickfindquery
                } | Out-Null
            }
        }
    }
    Request POST 'PublishXml' @{ ParameterXml = '<importexportxml><entities><entity>asx_rule</entity><entity>asx_rulerevision</entity><entity>asx_publicationlock</entity><entity>asx_tableconfig</entity><entity>asx_rulecondition</entity><entity>asx_ruleaction</entity><entity>asx_rulerun</entity><entity>asx_ruleschedule</entity><entity>asx_schedulerstatus</entity><entity>asx_rulediagnostic</entity><entity>asx_nodefiltergroup</entity><entity>asx_dataupdate</entity><entity>asx_actionconditiongroup</entity><entity>asx_actionconditiontest</entity></entities></importexportxml>' } | Out-Null
    Write-Host '[revisions] additive schema ready'
    return
}

$assembly = Request GET "pluginassemblies?`$select=pluginassemblyid&`$filter=name eq '$AssemblyName'"
if ($assembly.value.Count -ne 1) { throw 'Expected exactly one installed plugin assembly.' }
$assemblyId = $assembly.value[0].pluginassemblyid
function PluginType([string]$ShortName) {
    $type = Request GET "plugintypes?`$select=plugintypeid&`$filter=typename eq 'Ascentix.RulesEngine.Plugin.$ShortName' and _pluginassemblyid_value eq $assemblyId"
    if ($type.value.Count -ne 1) { throw "Deploy the assembly and plugin type manifest first: $ShortName" }
    $type.value[0].plugintypeid
}
function EnsureStep([string]$Table, [string]$Message, [string]$TypeId, [int]$Rank, [int]$Stage = 20) {
    $messages = Request GET "sdkmessages?`$select=sdkmessageid&`$filter=name eq '$Message'"
    if ($messages.value.Count -ne 1) { throw "Message $Message was not found uniquely." }
    $messageId = $messages.value[0].sdkmessageid
    $filterId = $null
    $filterQuery = '_sdkmessagefilterid_value eq null'
    if ($Table -ne '*') {
        $filters = Request GET "sdkmessagefilters?`$select=sdkmessagefilterid&`$filter=_sdkmessageid_value eq $messageId and primaryobjecttypecode eq '$Table'"
        if ($filters.value.Count -ne 1) { throw "Message $Message is not supported uniquely on $Table." }
        $filterId = $filters.value[0].sdkmessagefilterid
        $filterQuery = "_sdkmessagefilterid_value eq $filterId"
    }
    $existing = Request GET "sdkmessageprocessingsteps?`$select=sdkmessageprocessingstepid&`$filter=_eventhandler_value eq $TypeId and _sdkmessageid_value eq $messageId and $filterQuery and stage eq $Stage"
    $stepName = if ($Stage -eq 40) { "Ascentix revision cleanup: $Table $Message" } else { "Ascentix revision guard: $Table $Message" }
    $body = @{ name = $stepName; rank = $Rank; stage = $Stage; mode = 0; supporteddeployment = 0;
        'sdkmessageid@odata.bind' = "/sdkmessages($messageId)";
        'eventhandler_plugintype@odata.bind' = "/plugintypes($TypeId)"; filteringattributes = $null; statecode = 0; statuscode = 1 }
    if ($filterId) { $body['sdkmessagefilterid@odata.bind'] = "/sdkmessagefilters($filterId)" }
    if ($existing.value.Count -gt 1) { throw "Duplicate revision guards for $Table $Message" }
    if ($existing.value.Count -eq 0) { Request POST 'sdkmessageprocessingsteps' $body | Out-Null }
    else { Request PATCH "sdkmessageprocessingsteps($($existing.value[0].sdkmessageprocessingstepid))" $body | Out-Null }
}
$guard = PluginType 'RuleRevisionGuardPlugin'
$tables = @('asx_rule','asx_conditiongroup','asx_rulecondition','asx_searchcriteriagroup','asx_searchcriterion',
    'asx_nodefiltergroup','asx_nodefiltercriterion','asx_ruleaction','asx_localizedmessage','asx_tableconfig',
    'asx_actionconditiongroup','asx_actionconditiontest')
foreach ($table in $tables) { foreach ($message in @('Create','Update','Delete')) {
    $stage = if ($table -eq 'asx_rule' -and $message -eq 'Delete') { 10 } else { 20 }
    EnsureStep $table $message $guard 1 $stage
} }
# Capture before links are removed, clean owned rows inside Delete's transaction,
# then reclaim private models after the header is gone. Shared models survive.
EnsureStep 'asx_rule' 'Delete' $guard 1 20
EnsureStep 'asx_rule' 'Delete' $guard 1 40
# Revision-table access is controlled by Dataverse roles, not a plugin veto.
$revisionGuards = Request GET "sdkmessageprocessingsteps?`$select=sdkmessageprocessingstepid&`$filter=_eventhandler_value eq $guard and sdkmessagefilterid/primaryobjecttypecode eq 'asx_rulerevision'"
foreach ($step in $revisionGuards.value) { Request DELETE "sdkmessageprocessingsteps($($step.sdkmessageprocessingstepid))" | Out-Null }
EnsureStep 'asx_rule' 'SetState' $guard 1
EnsureStep '*' 'Associate' $guard 1
EnsureStep '*' 'Disassociate' $guard 1

# Existing publisher and registration steps keep their pre-images. Set explicit ordering.
foreach ($spec in @(@('RulePublishPlugin',20), @('RuleRegistrationPlugin',30))) {
    $typeId = PluginType $spec[0]
    $steps = Request GET "sdkmessageprocessingsteps?`$select=sdkmessageprocessingstepid,stage,mode,statecode&`$filter=_eventhandler_value eq $typeId"
    if ($steps.value.Count -eq 0) { throw "Missing existing $($spec[0]) registration. See docs/Plugin-Registration.md." }
    foreach ($step in $steps.value) {
        if ($step.stage -ne 20 -or $step.mode -ne 0) { throw "Expected synchronous pre-operation $($spec[0]) registration." }
        if ($step.statecode -ne 0) { throw "Enable the existing $($spec[0]) registration before deploying revisions." }
        Request PATCH "sdkmessageprocessingsteps($($step.sdkmessageprocessingstepid))" @{ rank = [int]$spec[1] } | Out-Null
    }
}
function EnsureApi([string]$Name, [string]$Privilege, [string]$Description, [string]$Display = $Name, [string]$TypeId = $revisionType) {
    $existing = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq '$Name'"
    $body = @{ uniquename = $Name; name = $Name; displayname = $Display; description = $Description; bindingtype = 0; isfunction = $false;
        allowedcustomprocessingsteptype = 0; isprivate = $false; workflowsdkstepenabled = $false;
        executeprivilegename = $Privilege; 'PluginTypeId@odata.bind' = "/plugintypes($TypeId)" }
    if ($existing.value.Count -eq 0) { Request POST 'customapis' $body | Out-Null; $existing = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq '$Name'" }
    else { Request PATCH "customapis($($existing.value[0].customapiid))" @{ 'PluginTypeId@odata.bind' = "/plugintypes($TypeId)"; executeprivilegename = $Privilege; description = $Description } | Out-Null }
    $existing.value[0].customapiid
}
function EnsureParameter([string]$ApiId, [string]$Name, [int]$Type, [bool]$Output, [string]$Description, [bool]$Optional = $false) {
    $set = if ($Output) { 'customapiresponseproperties' } else { 'customapirequestparameters' }
    $existing = Request GET "${set}?`$select=uniquename&`$filter=_customapiid_value eq $ApiId and uniquename eq '$Name'"
    if ($existing.value.Count -gt 0) { return }
    $body = @{ uniquename = $Name; name = $Name; displayname = $Name; description = $Description; type = $Type; 'CustomAPIId@odata.bind' = "/customapis($ApiId)" }
    if (!$Output) { $body.isoptional = $Optional }
    Request POST $set $body | Out-Null
}
$revisionType = PluginType 'RuleRevisionApi'
$authoringApis = @('asx_ReadPublishedRule', 'asx_RestoreRuleDraft', 'asx_OpenRuleDraft', 'asx_CopyRule', 'asx_DeleteRule')
$ownedApis = Request GET "customapis?`$select=customapiid,uniquename&`$filter=_plugintypeid_value eq $revisionType"
foreach ($api in $ownedApis.value) {
    if ($api.uniquename -notin $authoringApis) { Request DELETE "customapis($($api.customapiid))" | Out-Null }
}
foreach ($spec in @(
    @('asx_ReadPublishedRule', 'Read the immutable configuration of the active published rule revision.'),
    @('asx_RestoreRuleDraft', 'Restore the published configuration into a draft without changing active enforcement.')
)) {
    $privilege = if ($spec[0] -eq 'asx_RestoreRuleDraft') { 'prvWriteasx_rule' } else { 'prvReadasx_rule' }
    $id = EnsureApi $spec[0] $privilege $spec[1]
    EnsureParameter $id 'RuleId' 10 $false 'Identifier of the rule to read or restore.'
    if ($spec[0] -eq 'asx_ReadPublishedRule') { EnsureParameter $id 'Definition' 10 $true 'Serialized configuration of the active published rule revision.' }
    else {
        # Upgrade the previous restore contract; version checking no longer exists.
        $obsolete = Request GET "customapirequestparameters?`$select=customapirequestparameterid&`$filter=_customapiid_value eq $id and uniquename eq 'ExpectedVersion'"
        foreach ($parameter in $obsolete.value) { Request DELETE "customapirequestparameters($($parameter.customapirequestparameterid))" | Out-Null }
    }
}
$id = EnsureApi 'asx_OpenRuleDraft' 'prvWriteasx_rule' 'Open a separate working draft while the published rule continues enforcing.'
EnsureParameter $id 'RuleId' 10 $false 'Identifier of the rule to edit.'
EnsureParameter $id 'DraftId' 10 $true 'Identifier of the existing or newly created working draft.'
$id = EnsureApi 'asx_CopyRule' 'prvCreateasx_rule' 'Copy a rule definition and its model into a new unpublished rule.'
EnsureParameter $id 'RuleId' 10 $false 'Identifier of the source rule.'
EnsureParameter $id 'NewRuleId' 10 $true 'Identifier of the new unpublished rule.'
$id = EnsureApi 'asx_DeleteRule' 'prvDeleteasx_rule' 'Delete a rule, its working draft and owned configuration in one transaction before platform cascading begins.'
EnsureParameter $id 'RuleId' 10 $false 'Identifier of the rule or working draft to delete.'
$validate = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq 'asx_ValidateRule'"
if ($validate.value.Count -ne 1) { throw 'Missing asx_ValidateRule API.' }
EnsureParameter $validate.value[0].customapiid 'DraftHash' 10 $true 'SHA-256 hash of the saved draft configuration checked by validation.'
$runRules = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq 'asx_RunRules'"
if ($runRules.value.Count -ne 1) { throw 'Missing asx_RunRules API.' }
EnsureParameter $runRules.value[0].customapiid 'ChangeSet' 10 $true 'JSON change-set summary: creates, updates, deletes and unchanged rows.'
EnsureParameter $runRules.value[0].customapiid 'Outcomes' 10 $true 'JSON per record: each rule outcome (name and true or false).'
EnsureParameter $runRules.value[0].customapiid 'IncludeOutcomes' 0 $false 'When true, Outcomes carries each rule outcome per record; otherwise it is an empty JSON array.' $true
EnsureParameter $runRules.value[0].customapiid 'DraftRuleId' 12 $false 'Previews a draft: its authored rows run in place of the live rule it is a draft of.' $true
$applyRulesType = PluginType 'ApplyRulesApi'
$id = EnsureApi 'asx_ApplyRules' 'prvCreateasx_RuleRun' 'Evaluates one On demand rule for one record and applies its results (enforcing).' 'Apply Rules' $applyRulesType
EnsureParameter $id 'RuleId' 12 $false 'Identifier of the On demand rule to evaluate.'
EnsureParameter $id 'RecordId' 12 $false 'Identifier of the persisted record to evaluate the rule against.'
EnsureParameter $id 'IsValid' 0 $true 'True when no Block action fired.'
EnsureParameter $id 'Results' 10 $true 'JSON array of every fired action, in the asx_RunRules Results shape.'
EnsureParameter $id 'WriteCount' 7 $true 'Number of write actions applied.'
EnsureParameter $id 'IncludeDiagnostics' 0 $false 'When true, the response also carries Diagnostics: timings and counts for this call.' $true
EnsureParameter $id 'Diagnostics' 10 $true 'JSON timings and counts for this call; set only when IncludeDiagnostics is true.'
$processRunPageType = PluginType 'ProcessRunPageApi'
$id = EnsureApi 'asx_ProcessRunPage' 'prvCreateasx_RuleRun' 'Processes the next page of a Rule Run.' 'Process Run Page' $processRunPageType
EnsureParameter $id 'RunId' 12 $false 'Identifier of the Rule Run to process.'
EnsureParameter $id 'FailedRecordId' 12 $false 'Identifier of a record that failed evaluation on this page.' $true
EnsureParameter $id 'FailedMessage' 10 $false 'Error text for a record that failed evaluation on this page.' $true
EnsureParameter $id 'Done' 0 $true 'True when the run has no further pages to process.'
EnsureParameter $id 'Status' 7 $true 'Current status of the run.'
EnsureParameter $id 'Evaluated' 7 $true 'Running total of records evaluated.'
EnsureParameter $id 'Changed' 7 $true 'Running total of records that had at least one write applied.'
EnsureParameter $id 'Blocked' 7 $true 'Running total of records that fired a Block action.'
EnsureParameter $id 'Failed' 7 $true 'Running total of records that failed with an error.'
EnsureParameter $id 'Skipped' 7 $true 'Running total of records that did not pass the execution conditions.'
EnsureParameter $id 'IncludeDiagnostics' 0 $false 'When true, the response also carries Diagnostics: timings and counts for this call.' $true
EnsureParameter $id 'Diagnostics' 10 $true 'JSON timings and counts for this call; set only when IncludeDiagnostics is true.'
EnsureStep 'asx_rulerun' 'Create' (PluginType 'RuleRunPlugin') 1 20
# Outside asx_ProcessRunPage, a run may only be cancelled.
EnsureStep 'asx_rulerun' 'Update' (PluginType 'RuleRunUpdatePlugin') 1 20
$startDueSchedulesType = PluginType 'StartDueSchedulesApi'
$id = EnsureApi 'asx_StartDueSchedules' 'prvCreateasx_RuleRun' 'Starts or continues runs for due rule schedules and returns the run ids to drive.' 'Start Due Schedules' $startDueSchedulesType
EnsureParameter $id 'RunIds' 10 $true 'JSON array of the ids of the Rule Runs to drive: started, continued or resumed by this call.'
EnsureParameter $id 'ScheduledCount' 7 $true 'Number of due schedules processed by this call.'
EnsureParameter $id 'IncludeDiagnostics' 0 $false 'When true, the response also carries Diagnostics: timings and counts for this call.' $true
EnsureParameter $id 'Diagnostics' 10 $true 'JSON timings and counts for this call; set only when IncludeDiagnostics is true.'
$scheduleType = PluginType 'RuleSchedulePlugin'
EnsureStep 'asx_ruleschedule' 'Create' $scheduleType 1 20
EnsureStep 'asx_ruleschedule' 'Update' $scheduleType 1 20
$applyDataUpdatesType = PluginType 'ApplyDataUpdatesApi'
$id = EnsureApi 'asx_ApplyDataUpdates' 'prvReadasx_rule' 'Reports or applies the data updates this release needs.' 'Apply Data Updates' $applyDataUpdatesType
EnsureParameter $id 'Mode' 10 $false 'Status reports pending data updates; Apply runs them (System Administrator or System Customizer only).'
EnsureParameter $id 'Retry' 7 $false 'Number of a data update that completed with failures, to run again from the start.' $true
EnsureParameter $id 'FailedItem' 10 $false 'The item named by the previous call''s item-failed error.' $true
EnsureParameter $id 'FailedMessage' 10 $false 'Error text for the item named in FailedItem.' $true
EnsureParameter $id 'Required' 7 $true 'Highest data update number this release carries.'
EnsureParameter $id 'Pending' 10 $true 'JSON array of the data updates still to apply.'
EnsureParameter $id 'Latest' 10 $true 'JSON of the last data update run, with its failures.'
EnsureParameter $id 'CanApply' 0 $true 'True when the caller may apply data updates.'
EnsureParameter $id 'Done' 0 $true 'True when no data update is pending.'
Write-Host '[revisions] guards, lifecycle ordering, and APIs registered'
