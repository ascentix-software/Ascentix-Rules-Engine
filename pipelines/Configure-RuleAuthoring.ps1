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
function Request([string]$Method, [string]$Path, $Body = $null) {
    $args0 = @{ Method = $Method; Uri = "$base/$Path"; Headers = $headers }
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
function EnsureTable([string]$Name, [string]$Display) {
    $logical = $Name.ToLowerInvariant()
    $existing = Request GET "EntityDefinitions?`$select=LogicalName&`$filter=LogicalName eq '$logical'"
    if ($existing.value.Count -gt 0) { return }
    $primary = Field 'asx_Name' 'String' 'Name'; $primary.MaxLength = 200; $primary.IsPrimaryName = $true
    $primary.FormatName = @{ Value = 'Text' }
    Request POST 'EntityDefinitions' @{
        '@odata.type' = 'Microsoft.Dynamics.CRM.EntityMetadata'; SchemaName = $Name; EntitySetName = $logical + 's';
        DisplayName = (Label $Display); DisplayCollectionName = (Label ($Display + 's'));
        OwnershipType = 'OrganizationOwned'; HasActivities = $false; HasNotes = $false;
        IsActivity = $false; IsAuditEnabled = @{ Value = $false }; Attributes = @($primary)
    } | Out-Null
}
function EnsureLookup([string]$From, [string]$To, [string]$Name, [string]$Display, [string]$Delete = 'Restrict') {
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
        '@odata.type' = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'; SchemaName = "${From}_${logical}_revision";
        ReferencedEntity = $To; ReferencingEntity = $From; Lookup = (Field $Name 'Lookup' $Display);
        CascadeConfiguration = @{ Assign = 'NoCascade'; Delete = $Delete; Merge = 'NoCascade'; Reparent = 'NoCascade'; Share = 'NoCascade'; Unshare = 'NoCascade' }
    } | Out-Null
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
    Request POST 'PublishXml' @{ ParameterXml = '<importexportxml><entities><entity>asx_rule</entity><entity>asx_rulerevision</entity><entity>asx_publicationlock</entity><entity>asx_tableconfig</entity></entities></importexportxml>' } | Out-Null
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
    Request POST 'PublishXml' @{ ParameterXml = '<importexportxml><entities><entity>asx_rule</entity><entity>asx_rulerevision</entity><entity>asx_publicationlock</entity><entity>asx_tableconfig</entity></entities></importexportxml>' } | Out-Null
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
    'asx_nodefiltergroup','asx_nodefiltercriterion','asx_ruleaction','asx_localizedmessage','asx_tableconfig')
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
function EnsureApi([string]$Name, [string]$Privilege, [string]$Description) {
    $existing = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq '$Name'"
    $body = @{ uniquename = $Name; name = $Name; displayname = $Name; description = $Description; bindingtype = 0; isfunction = $false;
        allowedcustomprocessingsteptype = 0; isprivate = $false; workflowsdkstepenabled = $false;
        executeprivilegename = $Privilege; 'PluginTypeId@odata.bind' = "/plugintypes($revisionType)" }
    if ($existing.value.Count -eq 0) { Request POST 'customapis' $body | Out-Null; $existing = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq '$Name'" }
    else { Request PATCH "customapis($($existing.value[0].customapiid))" @{ 'PluginTypeId@odata.bind' = "/plugintypes($revisionType)"; executeprivilegename = $Privilege; description = $Description } | Out-Null }
    $existing.value[0].customapiid
}
function EnsureParameter([string]$ApiId, [string]$Name, [int]$Type, [bool]$Output, [string]$Description) {
    $set = if ($Output) { 'customapiresponseproperties' } else { 'customapirequestparameters' }
    $existing = Request GET "${set}?`$select=uniquename&`$filter=_customapiid_value eq $ApiId and uniquename eq '$Name'"
    if ($existing.value.Count -gt 0) { return }
    $body = @{ uniquename = $Name; name = $Name; displayname = $Name; description = $Description; type = $Type; 'CustomAPIId@odata.bind' = "/customapis($ApiId)" }
    if (!$Output) { $body.isoptional = $false }
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
Write-Host '[revisions] guards, lifecycle ordering, and APIs registered'
