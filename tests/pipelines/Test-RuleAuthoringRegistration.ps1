# Runs the real Register phase against an in-memory Web API; no environment or credentials required.
[CmdletBinding()]
param(
    [string]$DeploymentScript = (Join-Path $PSScriptRoot '../../pipelines/Configure-RuleAuthoring.ps1')
)
$ErrorActionPreference = 'Stop'
$fixtureId = '11111111-1111-1111-1111-111111111111'
$apis = @{}
$parameters = @{}
$state = @{ Creates = 0; FailParameterOnce = $false }

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
    if ($Method -eq 'PATCH' -and $path -match '^(sdkmessageprocessingsteps|customapis)\([\w-]+\)$') { return }
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
    Assert ($apis.Count -eq 5 -and $parameters.Count -eq 9) 'Expected four new APIs and nine parameters/properties.'
    Assert ($state.Creates -eq 13) 'Expected exactly thirteen successful creates.'
    foreach ($spec in @(
        @('asx_ReadPublishedRule', 'RuleId', 10), @('asx_ReadPublishedRule', 'Definition', 10),
        @('asx_RestoreRuleDraft', 'RuleId', 10), @('asx_RestoreRuleDraft', 'ExpectedVersion', 10),
        @('asx_OpenRuleDraft', 'RuleId', 10), @('asx_OpenRuleDraft', 'DraftId', 10), @('asx_CopyRule', 'RuleId', 10), @('asx_CopyRule', 'NewRuleId', 10), @('asx_ValidateRule', 'DraftHash', 10)
    )) {
        $binding = "/customapis($($apis[$spec[0]].customapiid))"
        $match = @($parameters.Values | Where-Object { $_.uniquename -eq $spec[1] -and $_['CustomAPIId@odata.bind'] -eq $binding })
        Assert ($match.Count -eq 1 -and $match[0].type -eq $spec[2]) "Incorrect contract for $($spec[0]).$($spec[1])."
    }
    Register
    Assert ($state.Creates -eq 13) 'Completed deployment retry created duplicate components.'
    Write-Host "PASS: API registration and idempotent retry (interrupted=$interrupt)."
}
