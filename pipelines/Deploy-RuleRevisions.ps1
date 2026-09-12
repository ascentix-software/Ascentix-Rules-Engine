<# Additive revision schema, registrations, and restartable backfill. Does not export Solutions/. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Schema','Register','Backfill')][string]$Phase,
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
    Invoke-RestMethod @args0
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
function EnsureLookup([string]$From, [string]$To, [string]$Name, [string]$Display) {
    $logical = $Name.ToLowerInvariant()
    $existing = Request GET "EntityDefinitions(LogicalName='$From')/Attributes?`$select=LogicalName&`$filter=LogicalName eq '$logical'"
    if ($existing.value.Count -gt 0) { return }
    Request POST 'RelationshipDefinitions' @{
        '@odata.type' = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'; SchemaName = "${From}_${logical}_revision";
        ReferencedEntity = $To; ReferencingEntity = $From; Lookup = (Field $Name 'Lookup' $Display);
        CascadeConfiguration = @{ Assign = 'NoCascade'; Delete = 'Restrict'; Merge = 'NoCascade'; Reparent = 'NoCascade'; Share = 'NoCascade'; Unshare = 'NoCascade' }
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
    foreach ($spec in @(@('asx_rule','asx_PublishedVersion'), @('asx_rulerevision','asx_Version'))) {
        $field = Field $spec[1] 'Integer' 'Published version'; $field.MinValue = 0; $field.MaxValue = 2147483647
        EnsureField $spec[0] $field
    }
    $date = Field 'asx_PublishedOn' 'DateTime' 'Published on'; $date.Format = 'DateAndTime'; $date.DateTimeBehavior = @{ Value = 'UserLocal' }
    EnsureField 'asx_rulerevision' $date
    EnsureLookup 'asx_rulerevision' 'asx_rule' 'asx_Rule' 'Rule'
    EnsureLookup 'asx_rulerevision' 'systemuser' 'asx_Publisher' 'Publisher'
    EnsureLookup 'asx_rule' 'asx_rulerevision' 'asx_PublishedRevision' 'Published revision'
    Request POST 'PublishXml' @{ ParameterXml = '<importexportxml><entities><entity>asx_rule</entity><entity>asx_rulerevision</entity><entity>asx_publicationlock</entity></entities></importexportxml>' } | Out-Null
    $locks = Request GET 'asx_publicationlocks?$select=asx_publicationlockid&$filter=asx_publicationlockid eq 7e0d7362-c0fd-44ab-a8a1-aecb70d86a79'
    if ($locks.value.Count -eq 0) {
        Request POST 'asx_publicationlocks' @{ asx_publicationlockid = '7e0d7362-c0fd-44ab-a8a1-aecb70d86a79'; asx_name = 'Configuration transaction lock' } | Out-Null
    }
    Write-Host '[revisions] additive schema ready'
    return
}

if ($Phase -eq 'Backfill') {
    do {
        $result = Request POST 'asx_InitializeRuleRevisions' @{}
        Write-Host "[revisions] legacy rules remaining: $($result.Remaining)"
    } while ([int]$result.Remaining -gt 0)
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
function EnsureStep([string]$Table, [string]$Message, [string]$TypeId, [int]$Rank) {
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
    $existing = Request GET "sdkmessageprocessingsteps?`$select=sdkmessageprocessingstepid&`$filter=_eventhandler_value eq $TypeId and _sdkmessageid_value eq $messageId and $filterQuery"
    $body = @{ name = "Ascentix revision guard: $Table $Message"; rank = $Rank; stage = 20; mode = 0; supporteddeployment = 0;
        'sdkmessageid@odata.bind' = "/sdkmessages($messageId)";
        'eventhandler_plugintype@odata.bind' = "/plugintypes($TypeId)"; filteringattributes = $null; statecode = 0; statuscode = 1 }
    if ($filterId) { $body['sdkmessagefilterid@odata.bind'] = "/sdkmessagefilters($filterId)" }
    if ($existing.value.Count -gt 1) { throw "Duplicate revision guards for $Table $Message" }
    if ($existing.value.Count -eq 0) { Request POST 'sdkmessageprocessingsteps' $body | Out-Null }
    else { Request PATCH "sdkmessageprocessingsteps($($existing.value[0].sdkmessageprocessingstepid))" $body | Out-Null }
}
$guard = PluginType 'RuleRevisionGuardPlugin'
$tables = @('asx_rule','asx_conditiongroup','asx_rulecondition','asx_searchcriteriagroup','asx_searchcriterion',
    'asx_nodefiltergroup','asx_nodefiltercriterion','asx_ruleaction','asx_localizedmessage','asx_tableconfig','asx_rulerevision')
foreach ($table in $tables) { foreach ($message in @('Create','Update','Delete')) { EnsureStep $table $message $guard 1 } }
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
function EnsureApi([string]$Name, [string]$Privilege) {
    $existing = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq '$Name'"
    $body = @{ uniquename = $Name; name = $Name; displayname = $Name; bindingtype = 0; isfunction = $false;
        allowedcustomprocessingsteptype = 0; isprivate = $false; workflowsdkstepenabled = $false;
        executeprivilegename = $Privilege; 'PluginTypeId@odata.bind' = "/plugintypes($revisionType)" }
    if ($existing.value.Count -eq 0) { Request POST 'customapis' $body | Out-Null; $existing = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq '$Name'" }
    else { Request PATCH "customapis($($existing.value[0].customapiid))" @{ 'PluginTypeId@odata.bind' = "/plugintypes($revisionType)"; executeprivilegename = $Privilege } | Out-Null }
    $existing.value[0].customapiid
}
function EnsureParameter([string]$ApiId, [string]$Name, [int]$Type, [bool]$Output) {
    $set = if ($Output) { 'customapiresponseproperties' } else { 'customapirequestparameters' }
    $existing = Request GET "${set}?`$select=uniquename&`$filter=_customapiid_value eq $ApiId and uniquename eq '$Name'"
    if ($existing.value.Count -gt 0) { return }
    $body = @{ uniquename = $Name; name = $Name; displayname = $Name; type = $Type; 'CustomAPIId@odata.bind' = "/customapis($ApiId)" }
    if (!$Output) { $body.isoptional = $false }
    Request POST $set $body | Out-Null
}
$revisionType = PluginType 'RuleRevisionApi'
foreach ($name in @('asx_ReadPublishedRule','asx_RestoreRuleDraft')) {
    $id = EnsureApi $name 'prvReadasx_rule'
    EnsureParameter $id 'RuleId' 10 $false
    if ($name -eq 'asx_ReadPublishedRule') { EnsureParameter $id 'Definition' 10 $true }
    else { EnsureParameter $id 'ExpectedVersion' 10 $false }
}
$id = EnsureApi 'asx_InitializeRuleRevisions' 'prvWriteEntity'
EnsureParameter $id 'Remaining' 7 $true
$validate = Request GET "customapis?`$select=customapiid&`$filter=uniquename eq 'asx_ValidateRule'"
if ($validate.value.Count -ne 1) { throw 'Missing asx_ValidateRule API.' }
EnsureParameter $validate.value[0].customapiid 'DraftHash' 10 $true
Write-Host '[revisions] guards, lifecycle ordering, and APIs registered'
