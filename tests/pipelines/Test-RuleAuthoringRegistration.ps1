# Runs authoring configuration against an in-memory Web API; no environment or credentials required.
[CmdletBinding()]
param(
    [string]$DeploymentScript = (Join-Path $PSScriptRoot '../../pipelines/Configure-RuleAuthoring.ps1')
)
$ErrorActionPreference = 'Stop'
$fixtureId = '11111111-1111-1111-1111-111111111111'
$apis = @{}
$parameters = @{}
$state = @{ Creates = 0; FailParameterOnce = $false; DeleteGuardId = $null; GuardCreates = 0; DeleteStages = @{}; RevisionGuard = $true; RunStepId = $null }
$pluginTypeIds = @{}

function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

# Distinct plugin types get distinct ids, so per-type filters (owned-API pruning, the
# Rule Run step) can be exercised precisely instead of every type colliding on one id.
function TypeId([string]$Name) {
    if (!$pluginTypeIds.ContainsKey($Name)) { $pluginTypeIds[$Name] = [guid]::NewGuid().ToString() }
    $pluginTypeIds[$Name]
}

# Existing schema, plugin types, guards, and ValidateRule API are deployment prerequisites.
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $ContentType, $Body)
    Assert ($Uri.StartsWith('https://registration.invalid/api/data/v9.2/')) 'Unexpected request origin.'
    $path = $Uri.Substring('https://registration.invalid/api/data/v9.2/'.Length)
    if ($Method -eq 'GET') {
        switch -Regex ($path) {
            '^pluginassemblies\?' { return @{ value = @(@{ pluginassemblyid = $fixtureId }) } }
            "^plugintypes\?.*typename eq 'Ascentix\.RulesEngine\.Plugin\.([^']+)'" { return @{ value = @(@{ plugintypeid = (TypeId $Matches[1]) }) } }
            '^sdkmessages\?' { return @{ value = @(@{ sdkmessageid = $fixtureId }) } }
            '^sdkmessagefilters\?' { return @{ value = @(@{ sdkmessagefilterid = $fixtureId }) } }
            '^sdkmessageprocessingsteps\?' {
                if ($path -match "primaryobjecttypecode eq 'asx_rulerevision'") { return @{ value = @(if ($state.RevisionGuard) { @{ sdkmessageprocessingstepid = '22222222-2222-2222-2222-222222222222' } }) } }
                if ($path -match 'stage eq 10$') {
                    return @{ value = @(if ($state.DeleteGuardId) { @{ sdkmessageprocessingstepid = $state.DeleteGuardId } }) }
                }
                if ($path -match "_eventhandler_value eq $(TypeId 'RuleRunPlugin') ") {
                    return @{ value = @(if ($state.RunStepId) { @{ sdkmessageprocessingstepid = $state.RunStepId } }) }
                }
                return @{ value = @(@{ sdkmessageprocessingstepid = $fixtureId; stage = 20; mode = 0; statecode = 0 }) }
            }
            '^customapis\?.*uniquename eq ''([^'']+)''' {
                $name = $Matches[1]
                return @{ value = @(if ($apis.ContainsKey($name)) { $apis[$name] }) }
            }
            '^customapis\?.*_plugintypeid_value eq ([\w-]+)' {
                $typeId = $Matches[1]
                return @{ value = @($apis.Values | Where-Object { $_['PluginTypeId@odata.bind'] -eq "/plugintypes($typeId)" }) }
            }
            '^(customapirequestparameters|customapiresponseproperties)\?.*_customapiid_value eq ([\w-]+) and uniquename eq ''([^'']+)''' {
                $key = "$($Matches[1])/$($Matches[2])/$($Matches[3])"
                return @{ value = @(if ($parameters.ContainsKey($key)) { $parameters[$key] }) }
            }
        }
    }
    if ($Method -in @('POST','PATCH') -and $path -match '^sdkmessageprocessingsteps(?:\([\w-]+\))?$') {
        $record = $Body | ConvertFrom-Json -AsHashtable
        if ($record.name -match '^Ascentix revision (guard|cleanup): asx_rule Delete$') {
            Assert ($record.mode -eq 0) 'Rule deletion cleanup must remain synchronous.'
            $state.DeleteStages[[int]$record.stage] = $true
        }
        if ($record['eventhandler_plugintype@odata.bind'] -eq "/plugintypes($(TypeId 'RuleRunPlugin'))") {
            Assert ($record.stage -eq 20 -and $record.mode -eq 0) 'Rule Run creation step must be a synchronous pre-operation step.'
            if ($Method -eq 'POST') {
                Assert (!$state.RunStepId) 'Only the missing Rule Run step should be created.'
                $state.RunStepId = [guid]::NewGuid().ToString()
                $state.Creates++
            } else {
                Assert ($path -eq "sdkmessageprocessingsteps($($state.RunStepId))") 'Rule Run step retry must update the same step.'
            }
            return
        }
        if ($Method -eq 'POST') {
            Assert ($record.stage -eq 10 -and !$state.DeleteGuardId) 'Only the missing prevalidation guard should be created.'
            $state.DeleteGuardId = [guid]::NewGuid().ToString()
            $state.GuardCreates++
        } elseif ($record.stage -eq 10) {
            Assert ($path -eq "sdkmessageprocessingsteps($($state.DeleteGuardId))") 'Prevalidation retry must update the same step.'
        }
        return
    }
    if ($Method -eq 'DELETE' -and $path -eq 'sdkmessageprocessingsteps(22222222-2222-2222-2222-222222222222)') { $state.RevisionGuard = $false; return }
    if ($Method -eq 'PATCH' -and $path -match '^customapis\([\w-]+\)$') { return }
    if ($Method -eq 'DELETE' -and $path -match '^customapirequestparameters\(([\w-]+)\)$') {
        $id = $Matches[1]
        $keys = @($parameters.Keys | Where-Object { $parameters[$_].customapirequestparameterid -eq $id })
        Assert ($keys.Count -eq 1) 'Attempted to remove an unknown API parameter.'
        $parameters.Remove($keys[0])
        return
    }
    if ($Method -eq 'DELETE' -and $path -match '^customapis\(([\w-]+)\)$') {
        $id = $Matches[1]
        foreach ($name in @($apis.Keys)) { if ($apis[$name].customapiid -eq $id) { $apis.Remove($name) } }
        return
    }
    if ($Method -eq 'POST' -and $path -in @('customapis', 'customapirequestparameters', 'customapiresponseproperties')) {
        $record = $Body | ConvertFrom-Json -AsHashtable
        foreach ($field in @('uniquename', 'name', 'displayname', 'description')) {
            Assert (![string]::IsNullOrWhiteSpace($record[$field])) "POST ${path}: Attribute '$field' cannot be NULL or empty."
        }
        $maxDescription = if ($path -eq 'customapiresponseproperties') { 100 } else { 300 }
        Assert ($record.description.Length -le $maxDescription) "POST ${path}: description exceeds metadata length."
        if ($path -eq 'customapis') {
            Assert (!$apis.ContainsKey($record.uniquename)) 'Duplicate API create on retry.'
            $record.customapiid = [guid]::NewGuid().ToString()
            $apis[$record.uniquename] = $record
        } else {
            if ($state.FailParameterOnce) {
                $state.FailParameterOnce = $false
                throw 'Simulated interruption after API creation.'
            }
            Assert ($record['CustomAPIId@odata.bind'] -match '^/customapis\(([\w-]+)\)$') 'Missing parent API binding.'
            $apiId = $Matches[1]
            Assert (@($apis.Values | Where-Object { $_.customapiid -eq $apiId }).Count -eq 1) 'Unknown parent API.'
            $key = "$path/$apiId/$($record.uniquename)"
            Assert (!$parameters.ContainsKey($key)) 'Duplicate parameter create on retry.'
            if ($path -eq 'customapirequestparameters') {
                $expectOptional = $record.uniquename -in @('FailedRecordId', 'FailedMessage')
                Assert ($record.isoptional -eq $expectOptional) "Unexpected optionality for $($record.uniquename)."
            }
            $parameters[$key] = $record
        }
        $state.Creates++
        return
    }
    throw "Unexpected request: $Method $path"
}

function Register {
    & $DeploymentScript -Phase Register -EnvUrl 'https://registration.invalid' -AccessToken 'mock'
}

foreach ($interrupt in @($false, $true)) {
    $apis.Clear()
    $apis['asx_ValidateRule'] = @{ customapiid = $fixtureId; uniquename = 'asx_ValidateRule' }
    $apis['asx_RetiredAuthoringOperation'] = @{ customapiid = [guid]::NewGuid().ToString(); uniquename = 'asx_RetiredAuthoringOperation'
        'PluginTypeId@odata.bind' = "/plugintypes($(TypeId 'RuleRevisionApi'))" }
    $parameters.Clear()
    $state.Creates = 0; $state.RevisionGuard = $true
    $state.DeleteGuardId = $null; $state.GuardCreates = 0; $state.DeleteStages.Clear()
    $state.RunStepId = $null
    $state.FailParameterOnce = $interrupt
    if ($interrupt) {
        $interrupted = $false
        try { Register } catch {
            if ($_.Exception.Message -ne 'Simulated interruption after API creation.') { throw }
            $interrupted = $true
        }
        Assert $interrupted 'Partial-deployment scenario did not interrupt.'
        Assert ($apis.Count -eq 2 -and $parameters.Count -eq 0) 'Unexpected partial-deployment state.'
    }
    Register
    Assert ($apis.Count -eq 8 -and $parameters.Count -eq 24) 'Expected seven new APIs and twenty-four parameters/properties.'
    Assert ($state.Creates -eq 32) 'Expected exactly thirty-two successful creates.'
    foreach ($spec in @(
        @('asx_ReadPublishedRule', 'RuleId', 10), @('asx_ReadPublishedRule', 'Definition', 10),
        @('asx_RestoreRuleDraft', 'RuleId', 10),
        @('asx_OpenRuleDraft', 'RuleId', 10), @('asx_OpenRuleDraft', 'DraftId', 10), @('asx_CopyRule', 'RuleId', 10), @('asx_CopyRule', 'NewRuleId', 10), @('asx_DeleteRule', 'RuleId', 10), @('asx_ValidateRule', 'DraftHash', 10)
    )) {
        $binding = "/customapis($($apis[$spec[0]].customapiid))"
        $match = @($parameters.Values | Where-Object { $_.uniquename -eq $spec[1] -and $_['CustomAPIId@odata.bind'] -eq $binding })
        Assert ($match.Count -eq 1 -and $match[0].type -eq $spec[2]) "Incorrect contract for $($spec[0]).$($spec[1])."
    }
    foreach ($apiName in @('asx_ApplyRules', 'asx_ProcessRunPage')) {
        Assert ($apis[$apiName].executeprivilegename -eq 'prvCreateasx_rulerun' -and $apis[$apiName].bindingtype -eq 0 -and $apis[$apiName].isfunction -eq $false) "Incorrect contract for $apiName."
    }
    # (Api, Parameter, Type, IsOutput, IsOptional) — IsOptional is ignored for outputs.
    foreach ($spec in @(
        @('asx_ApplyRules', 'RuleId', 12, $false, $false), @('asx_ApplyRules', 'RecordId', 12, $false, $false),
        @('asx_ApplyRules', 'IsValid', 0, $true, $false), @('asx_ApplyRules', 'Results', 10, $true, $false), @('asx_ApplyRules', 'WriteCount', 7, $true, $false),
        @('asx_ProcessRunPage', 'RunId', 12, $false, $false), @('asx_ProcessRunPage', 'FailedRecordId', 12, $false, $true), @('asx_ProcessRunPage', 'FailedMessage', 10, $false, $true),
        @('asx_ProcessRunPage', 'Done', 0, $true, $false), @('asx_ProcessRunPage', 'Status', 7, $true, $false), @('asx_ProcessRunPage', 'Evaluated', 7, $true, $false),
        @('asx_ProcessRunPage', 'Changed', 7, $true, $false), @('asx_ProcessRunPage', 'Blocked', 7, $true, $false), @('asx_ProcessRunPage', 'Failed', 7, $true, $false), @('asx_ProcessRunPage', 'Skipped', 7, $true, $false)
    )) {
        $binding = "/customapis($($apis[$spec[0]].customapiid))"
        $match = @($parameters.Values | Where-Object { $_.uniquename -eq $spec[1] -and $_['CustomAPIId@odata.bind'] -eq $binding })
        Assert ($match.Count -eq 1 -and $match[0].type -eq $spec[2]) "Incorrect contract for $($spec[0]).$($spec[1])."
        if (!$spec[3]) { Assert ($match[0].isoptional -eq $spec[4]) "Incorrect optionality for $($spec[0]).$($spec[1])." }
    }
    Assert (($null -ne $state.RunStepId)) 'Expected the Rule Run creation step to be registered.'
    # Simulate upgrading the old restore contract. A same-named input on another
    # API must survive, and rerunning registration must not recreate the old input.
    $restoreVersionKey = "customapirequestparameters/$($apis['asx_RestoreRuleDraft'].customapiid)/ExpectedVersion"
    $otherVersionKey = "customapirequestparameters/$fixtureId/ExpectedVersion"
    $parameters[$restoreVersionKey] = @{ uniquename = 'ExpectedVersion'; customapirequestparameterid = [guid]::NewGuid().ToString() }
    $parameters[$otherVersionKey] = @{ uniquename = 'ExpectedVersion'; customapirequestparameterid = [guid]::NewGuid().ToString() }
    Register
    Assert (!$parameters.ContainsKey($restoreVersionKey)) 'Restore must not retain its obsolete version input.'
    Assert ($parameters.ContainsKey($otherVersionKey)) 'Registration removed another API parameter.'
    $parameters.Remove($otherVersionKey)
    Register
    Assert ($parameters.Count -eq 24 -and $state.Creates -eq 32) 'Completed deployment retry changed the API contract.'
    Assert ($state.GuardCreates -eq 1 -and $state.DeleteStages.Count -eq 3 -and $state.DeleteStages.ContainsKey(10) -and $state.DeleteStages.ContainsKey(20) -and $state.DeleteStages.ContainsKey(40)) 'Expected capture in PreValidation and transactional cleanup in PreOperation/PostOperation.'
    Assert (!$state.RevisionGuard) 'Revision-table plugin vetoes must be removed.'
    Assert ($apis['asx_OpenRuleDraft'].executeprivilegename -eq 'prvWriteasx_rule') 'Opening a draft requires the platform Write privilege.'
    Assert ($apis['asx_RestoreRuleDraft'].executeprivilegename -eq 'prvWriteasx_rule') 'Restoring a draft requires the platform Write privilege.'
    Assert ($apis['asx_DeleteRule'].executeprivilegename -eq 'prvDeleteasx_rule') 'Delete API must require the table Delete privilege.'
    Write-Host "PASS: API registration and idempotent retry (interrupted=$interrupt)."
}

& {
    $views = @{}
    $viewContexts = @{}
    $fields = @{}
    $tables = @{}
    $relationships = @{}
    $optionSets = @{}
    $schemaState = @{ Writes = 0; FailViewOnce = $false }
    function Invoke-RestMethod {
        param($Method, $Uri, $Headers, $ContentType, $Body)
        $path = $Uri.Substring('https://registration.invalid/api/data/v9.2/'.Length)
        $record = if ($Body) { $Body | ConvertFrom-Json -AsHashtable } else { @{} }
        if ($Method -eq 'GET') {
            switch -Regex ($path) {
                "^EntityDefinitions\?.*LogicalName eq '([^']+)'" {
                    return @{ value = @(if ($tables.ContainsKey($Matches[1])) { $tables[$Matches[1]] }) }
                }
                "^EntityDefinitions\(LogicalName='([^']+)'\)/Attributes\?.*LogicalName eq '([^']+)'" {
                    return @{ value = @(if ($fields.ContainsKey("$($Matches[1])/$($Matches[2])")) { @{ LogicalName = $Matches[2] } }) }
                }
                "^EntityDefinitions\(LogicalName='([^']+)'\)/ManyToOneRelationships\?.*ReferencingAttribute eq '([^']+)'" {
                    return @{ value = @($relationships.Values | Where-Object { $_.ReferencingEntity -eq $Matches[1] -and $_.ReferencingAttribute -eq $Matches[2] }) }
                }
                "^GlobalOptionSetDefinitions\(Name='([^']+)'\)/Microsoft\.Dynamics\.CRM\.OptionSetMetadata" {
                    $name = $Matches[1]
                    return @{ Options = @(@{ Value = $optionSets[$name].Value; Label = @{ LocalizedLabels = @(@{ Label = $optionSets[$name].Label; LanguageCode = 1033 }) } }) }
                }
                '^savedqueries\(([\w-]+)\)' {
                    return $viewContexts[$Matches[1]] + @{ fetchxml = $views[$Matches[1]] }
                }
            }
        }
        if ($Method -eq 'POST') {
            switch -Regex ($path) {
                '^EntityDefinitions$' {
                    $name = $record.SchemaName.ToLowerInvariant()
                    Assert (!$tables.ContainsKey($name)) 'Duplicate table creation.'
                    $tables[$name] = @{ LogicalName = $name; OwnershipType = $record.OwnershipType }
                    $schemaState.Writes++
                    return
                }
                "^EntityDefinitions\(LogicalName='([^']+)'\)/Attributes$" {
                    $key = "$($Matches[1])/$($record.SchemaName.ToLowerInvariant())"
                    Assert (!$fields.ContainsKey($key)) 'Duplicate field creation.'
                    $fields[$key] = $record
                    $schemaState.Writes++
                    return
                }
                '^RelationshipDefinitions$' {
                    $key = "$($record.ReferencingEntity)/$($record.Lookup.SchemaName.ToLowerInvariant())"
                    Assert (!$fields.ContainsKey($key)) 'Duplicate lookup creation.'
                    $fields[$key] = $record.Lookup
                    $record.MetadataId = [guid]::NewGuid().ToString()
                    $record.ReferencingAttribute = $record.Lookup.SchemaName.ToLowerInvariant()
                    $relationships[$record.MetadataId] = $record
                    $schemaState.Writes++
                    return
                }
                '^PublishXml$' { return }
                '^UpdateOptionValue$' {
                    Assert ($optionSets.ContainsKey($record.OptionSetName) -and $optionSets[$record.OptionSetName].Value -eq $record.Value -and $record.MergeLabels -eq $true) 'Unexpected option label update.'
                    $optionSets[$record.OptionSetName].Label = ($record.Label.LocalizedLabels | Where-Object { $_.LanguageCode -eq 1033 }).Label
                    $schemaState.Writes++
                    return
                }
            }
        }
        if ($Method -eq 'PUT' -and $path -match '^RelationshipDefinitions\(([\w-]+)\)$') {
            Assert ($relationships.ContainsKey($Matches[1])) 'Unknown relationship update.'
            $relationships[$Matches[1]].CascadeConfiguration = $record.CascadeConfiguration
            $schemaState.Writes++
            return
        }
        if ($Method -eq 'PATCH' -and $path -match '^savedqueries\(([\w-]+)\)$') {
            $id = $Matches[1]
            Assert ($views.ContainsKey($id)) 'Updated a view outside the shipped view manifest.'
            [xml]$before = $views[$id]
            [xml]$after = $record.fetchxml
            $entity = $after.fetch.entity
            $rowFilters = @($entity.SelectNodes("filter[not(@isquickfindfields='1' or @isquickfindfields='true')]"))
            Assert ($rowFilters.Count -eq 1 -and $rowFilters[0].type -eq 'and') 'Expected a single AND row-selection filter.'
            $field = if ($entity.name -eq 'asx_rule') { 'asx_draftof' } else { 'asx_isprivate' }
            Assert ($null -ne $rowFilters[0].SelectSingleNode("condition[@attribute='$field']")) 'Exclusion must apply to every row, outside any OR or search filter.'
            $searchPath = "/fetch/entity/filter[@isquickfindfields='1']"
            foreach ($property in @('layoutxml', 'returnedtypecode', 'querytype', 'isquickfindquery')) {
                Assert ($record.ContainsKey($property) -and $record[$property] -ceq $viewContexts[$id][$property]) "View update omitted or changed $property."
            }
            Assert ($before.SelectSingleNode($searchPath).OuterXml -ceq $after.SelectSingleNode($searchPath).OuterXml) 'Quick Find search criteria changed.'
            foreach ($oldFilter in $before.SelectNodes("/fetch/entity/filter[not(@isquickfindfields='1')]")) {
                foreach ($child in $oldFilter.ChildNodes) {
                    Assert ($record.fetchxml.Contains($child.OuterXml)) 'Existing view criteria were lost or regrouped.'
                }
                if ($oldFilter.type -eq 'or') {
                    Assert ($record.fetchxml.Contains($oldFilter.OuterXml)) 'An existing OR filter was widened or changed to AND.'
                }
            }
            if ($schemaState.FailViewOnce) { $schemaState.FailViewOnce = $false; throw 'Simulated view update interruption.' }
            $views[$id] = $record.fetchxml
            $schemaState.Writes++
            return
        }
        throw "Unexpected schema request: $Method $path"
    }
    foreach ($interrupt in @($false, $true)) {
        $views.Clear(); $viewContexts.Clear(); $fields.Clear(); $tables.Clear(); $relationships.Clear()
        $optionSets.Clear(); $optionSets['asx_triggers'] = @{ Value = 3; Label = 'Manual' }
        $schemaState.Writes = 0; $schemaState.FailViewOnce = $interrupt
        foreach ($table in @('asx_rule', 'asx_tableconfig')) {
            $folder = Join-Path $PSScriptRoot "../../Solutions/AscentixRulesEngine/AscentixRulesEngine_unmanaged/Entities/$table/SavedQueries"
            foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.xml') {
                [xml]$source = Get-Content -LiteralPath $file.FullName -Raw
                $id = ([string]$source.savedqueries.savedquery.savedqueryid).Trim('{}')
                $views[$id] = $source.savedqueries.savedquery.fetchxml.fetch.OuterXml
                $viewContexts[$id] = @{ layoutxml = $source.savedqueries.savedquery.layoutxml.grid.OuterXml;
                    returnedtypecode = $table; querytype = [int]$source.savedqueries.savedquery.querytype;
                    isquickfindquery = $source.savedqueries.savedquery.isquickfindquery -eq '1' }
            }
        }
        # Exercise OR and multiple ordinary filters as well as the actual shipped Quick Find views.
        $ordinaryIds = @($views.Keys | Where-Object { $views[$_] -notmatch 'isquickfindfields' -and $views[$_] -match 'name="asx_rule"' } | Sort-Object)
        $views[$ordinaryIds[0]] = '<fetch><entity name="asx_rule"><filter type="or"><condition attribute="statecode" operator="eq" value="0" /><condition attribute="asx_name" operator="eq" value="Example" /></filter></entity></fetch>'
        $views[$ordinaryIds[1]] = '<fetch><entity name="asx_rule"><filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter><filter type="or"><condition attribute="asx_name" operator="eq" value="A" /><condition attribute="asx_name" operator="eq" value="B" /></filter></entity></fetch>'
        if ($interrupt) {
            $interrupted = $false
            try { & $DeploymentScript -Phase Schema -EnvUrl 'https://registration.invalid' -AccessToken 'mock' }
            catch { if ($_.Exception.Message -ne 'Simulated view update interruption.') { throw }; $interrupted = $true }
            Assert $interrupted 'Schema retry scenario did not interrupt.'
        }
        & $DeploymentScript -Phase Schema -EnvUrl 'https://registration.invalid' -AccessToken 'mock'
        Assert ($tables.Count -eq 3 -and $fields.Count -eq 32) 'Expected additive authoring tables and fields.'
        Assert ($fields['asx_rulecondition/asx_expressionfilters'].MaxLength -eq 100000) 'Expected the Calculation expression filters column.'
        Assert ($fields['asx_rule/asx_evaluationtimezone'].MaxLength -eq 100) 'Expected the rule evaluation time zone column.'
        Assert ($null -ne $fields['asx_ruleaction/asx_applytoprevious']) 'Expected the apply-to-previous action column.'
        Assert ($tables['asx_rulerun'].OwnershipType -eq 'UserOwned') 'Rule Run must be a user-owned table.'
        $onDemandOptions = $fields['asx_rule/asx_ondemandscope'].OptionSet.Options
        Assert ((($onDemandOptions | Where-Object { $_.Value -eq 1 }).Label.LocalizedLabels[0].Label) -eq "A record it's given") 'Incorrect label for Runs for option 1.'
        Assert ((($onDemandOptions | Where-Object { $_.Value -eq 2 }).Label.LocalizedLabels[0].Label) -eq 'All records that pass its execution conditions') 'Incorrect label for Runs for option 2.'
        Assert ($optionSets['asx_triggers'].Label -eq 'On demand') 'Expected trigger option 3 relabeled to On demand.'
        Assert ($schemaState.Writes -eq (36 + $views.Count)) 'Unexpected metadata write count.'
        $writes = $schemaState.Writes
        & $DeploymentScript -Phase Schema -EnvUrl 'https://registration.invalid' -AccessToken 'mock'
        Assert ($schemaState.Writes -eq $writes) 'Schema retry changed already configured metadata.'
        Assert ($optionSets['asx_triggers'].Label -eq 'On demand') 'A re-run must not relabel an already-updated option.'
        # Upgrade the previous restrictive lifecycle relationships without changing
        # publisher ownership or any non-delete cascade setting.
        foreach ($relation in $relationships.Values) { $relation.CascadeConfiguration.Delete = 'Restrict' }
        & $DeploymentScript -Phase Schema -EnvUrl 'https://registration.invalid' -AccessToken 'mock'
        Assert ($schemaState.Writes -eq $writes + 4) 'Expected exactly four relationship upgrades.'
        foreach ($relation in $relationships.Values) {
            $expected = if ($relation.ReferencingAttribute -eq 'asx_publisher') { 'Restrict' }
                elseif ($relation.ReferencingEntity -eq 'asx_rulerun') { 'Cascade' }
                else { 'RemoveLink' }
            Assert ($relation.CascadeConfiguration.Delete -eq $expected) 'Incorrect native delete relationship behavior.'
            Assert ($relation.CascadeConfiguration.Assign -eq 'NoCascade') 'Unrelated cascade setting changed.'
        }
        & $DeploymentScript -Phase Schema -EnvUrl 'https://registration.invalid' -AccessToken 'mock'
        Assert ($schemaState.Writes -eq $writes + 4) 'Relationship upgrade is not idempotent.'
        Write-Host "PASS: schema and shipped views, filter preservation, idempotent retry (interrupted=$interrupt)."
    }
}
