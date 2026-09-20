# Runs authoring configuration against an in-memory Web API; no environment or credentials required.
[CmdletBinding()]
param(
    [string]$DeploymentScript = (Join-Path $PSScriptRoot '../../pipelines/Configure-RuleAuthoring.ps1')
)
$ErrorActionPreference = 'Stop'
$fixtureId = '11111111-1111-1111-1111-111111111111'
$apis = @{}
$parameters = @{}
$state = @{ Creates = 0; FailParameterOnce = $false; DeleteGuardId = $null; GuardCreates = 0; DeleteStages = @{}; Retired = @{} }

function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

# Existing schema, plugin types, guards, and ValidateRule API are deployment prerequisites.
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $ContentType, $Body)
    Assert ($Uri.StartsWith('https://registration.invalid/api/data/v9.2/')) 'Unexpected request origin.'
    $path = $Uri.Substring('https://registration.invalid/api/data/v9.2/'.Length)
    if ($Method -eq 'GET') {
        switch -Regex ($path) {
            '^pluginassemblies\?' { return @{ value = @(@{ pluginassemblyid = $fixtureId }) } }
            '^plugintypes\?' { return @{ value = @(@{ plugintypeid = $fixtureId }) } }
            '^sdkmessages\?' { return @{ value = @(@{ sdkmessageid = $fixtureId }) } }
            '^sdkmessagefilters\?' { return @{ value = @(@{ sdkmessagefilterid = $fixtureId }) } }
            '^sdkmessageprocessingsteps\?' {
                if ($path -match 'stage ne 10$') { return @{ value = @($state.Retired.Values) } }
                if ($path -match 'stage eq 10$') {
                    return @{ value = @(if ($state.DeleteGuardId) { @{ sdkmessageprocessingstepid = $state.DeleteGuardId } }) }
                }
                return @{ value = @(@{ sdkmessageprocessingstepid = $fixtureId; stage = 20; mode = 0; statecode = 0 }) }
            }
            '^customapis\?.*uniquename eq ''([^'']+)''' {
                $name = $Matches[1]
                return @{ value = @(if ($apis.ContainsKey($name)) { $apis[$name] }) }
            }
            '^customapis\?.*_plugintypeid_value eq' {
                return @{ value = @($apis.Values | Where-Object { $_.uniquename -ne 'asx_ValidateRule' }) }
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
        if ($Method -eq 'POST') {
            Assert ($record.stage -eq 10 -and !$state.DeleteGuardId) 'Only the missing prevalidation guard should be created.'
            $state.DeleteGuardId = [guid]::NewGuid().ToString()
            $state.GuardCreates++
        } elseif ($record.stage -eq 10) {
            Assert ($path -eq "sdkmessageprocessingsteps($($state.DeleteGuardId))") 'Prevalidation retry must update the same step.'
        }
        return
    }
    if ($Method -eq 'DELETE' -and $path -match '^sdkmessageprocessingsteps\(([\w-]+)\)$') {
        Assert ($state.Retired.ContainsKey($Matches[1])) 'Only obsolete rule Delete steps may be removed.'
        $state.Retired.Remove($Matches[1]); return
    }
    if ($Method -eq 'PATCH' -and $path -match '^customapis\([\w-]+\)$') { return }
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
                Assert ($record.ContainsKey('isoptional') -and !$record.isoptional) 'Request parameter must be required.'
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
    $apis['asx_RetiredAuthoringOperation'] = @{ customapiid = [guid]::NewGuid().ToString(); uniquename = 'asx_RetiredAuthoringOperation' }
    $parameters.Clear()
    $state.Creates = 0
    $state.DeleteGuardId = $null; $state.GuardCreates = 0; $state.DeleteStages.Clear(); $state.Retired.Clear()
    foreach ($stage in @(20,40)) { $id = [guid]::NewGuid().ToString(); $state.Retired[$id] = @{ sdkmessageprocessingstepid = $id; stage = $stage } }
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
    Assert ($apis.Count -eq 6 -and $parameters.Count -eq 10) 'Expected five new APIs and ten parameters/properties.'
    Assert ($state.Creates -eq 15) 'Expected exactly fifteen successful creates.'
    foreach ($spec in @(
        @('asx_ReadPublishedRule', 'RuleId', 10), @('asx_ReadPublishedRule', 'Definition', 10),
        @('asx_RestoreRuleDraft', 'RuleId', 10), @('asx_RestoreRuleDraft', 'ExpectedVersion', 10),
        @('asx_OpenRuleDraft', 'RuleId', 10), @('asx_OpenRuleDraft', 'DraftId', 10), @('asx_CopyRule', 'RuleId', 10), @('asx_CopyRule', 'NewRuleId', 10), @('asx_DeleteRule', 'RuleId', 10), @('asx_ValidateRule', 'DraftHash', 10)
    )) {
        $binding = "/customapis($($apis[$spec[0]].customapiid))"
        $match = @($parameters.Values | Where-Object { $_.uniquename -eq $spec[1] -and $_['CustomAPIId@odata.bind'] -eq $binding })
        Assert ($match.Count -eq 1 -and $match[0].type -eq $spec[2]) "Incorrect contract for $($spec[0]).$($spec[1])."
    }
    Register
    Assert ($state.Creates -eq 15) 'Completed deployment retry created duplicate components.'
    Assert ($state.GuardCreates -eq 1 -and $state.DeleteStages.Count -eq 1 -and $state.DeleteStages.ContainsKey(10) -and $state.Retired.Count -eq 0) 'Expected one prevalidation guard and removal of both old Delete steps.'
    Assert ($apis['asx_DeleteRule'].executeprivilegename -eq 'prvDeleteasx_rule') 'Delete API must require the table Delete privilege.'
    Write-Host "PASS: API registration and idempotent retry (interrupted=$interrupt)."
}

& {
    $views = @{}
    $viewContexts = @{}
    $fields = @{}
    $tables = @{}
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
                    $tables[$name] = @{ LogicalName = $name }
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
                    $schemaState.Writes++
                    return
                }
                '^PublishXml$' { return }
            }
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
        $views.Clear(); $viewContexts.Clear(); $fields.Clear(); $tables.Clear()
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
        Assert ($tables.Count -eq 2 -and $fields.Count -eq 13) 'Expected additive authoring tables and fields.'
        Assert ($schemaState.Writes -eq (15 + $views.Count)) 'Unexpected metadata write count.'
        $writes = $schemaState.Writes
        & $DeploymentScript -Phase Schema -EnvUrl 'https://registration.invalid' -AccessToken 'mock'
        Assert ($schemaState.Writes -eq $writes) 'Schema retry changed already configured metadata.'
        Write-Host "PASS: schema and shipped views, filter preservation, idempotent retry (interrupted=$interrupt)."
    }
}
