# Runs the scheduler add-on deployment against an in-memory Web API; no environment or credentials required.
[CmdletBinding()]
param(
    [string]$DeploymentScript = (Join-Path $PSScriptRoot '../../pipelines/scheduler/Deploy-Scheduler.ps1')
)
$ErrorActionPreference = 'Stop'
$origin = 'https://scheduler.invalid/api/data/v9.2/'
$publisherId = '33333333-3333-3333-3333-333333333333'
$solutions = @{ AscentixRulesEngine = @{ solutionid = [guid]::NewGuid().ToString(); _publisherid_value = $publisherId } }
$connectionReferences = @{}
$workflows = @{}
$writes = [System.Collections.Generic.List[string]]::new()

function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $ContentType, $Body)
    Assert ($Uri.StartsWith($origin)) 'Unexpected request origin.'
    $path = $Uri.Substring($origin.Length)
    $record = if ($Body) { $Body | ConvertFrom-Json -AsHashtable } else { @{} }
    $inAddOn = $Headers['MSCRM.SolutionUniqueName'] -eq 'AscentixRulesEngineScheduler'
    if ($Method -eq 'GET') {
        switch -Regex ($path) {
            "^solutions\?.*uniquename eq '([^']+)'" {
                Assert (!$Headers.ContainsKey('MSCRM.SolutionUniqueName')) 'Solution lookups must not target a solution.'
                return @{ value = @(if ($solutions.ContainsKey($Matches[1])) { $solutions[$Matches[1]] }) }
            }
            "^connectionreferences\?.*connectionreferencelogicalname eq '([^']+)'" {
                return @{ value = @(if ($connectionReferences.ContainsKey($Matches[1])) { $connectionReferences[$Matches[1]] }) }
            }
            "^workflows\?.*name eq '([^']+)' and category eq 5" {
                return @{ value = @(if ($workflows.ContainsKey($Matches[1])) { $workflows[$Matches[1]] }) }
            }
        }
    }
    if ($Method -eq 'POST' -and $path -eq 'solutions') {
        Assert (!$Headers.ContainsKey('MSCRM.SolutionUniqueName')) 'Creating the add-on solution must not target a solution.'
        Assert (!$solutions.ContainsKey($record.uniquename)) 'Duplicate solution create.'
        Assert ($record['publisherid@odata.bind'] -eq "/publishers($publisherId)") 'The add-on must share the core solution publisher.'
        Assert (![string]::IsNullOrWhiteSpace($record.friendlyname) -and ![string]::IsNullOrWhiteSpace($record.version)) 'Solution needs a name and version.'
        $record.solutionid = [guid]::NewGuid().ToString()
        $solutions[$record.uniquename] = $record
        $writes.Add("POST solutions")
        return
    }
    if ($Method -eq 'POST' -and $path -eq 'connectionreferences') {
        Assert $inAddOn 'The connection reference must be created in the add-on solution.'
        Assert (!$connectionReferences.ContainsKey($record.connectionreferencelogicalname)) 'Duplicate connection reference create.'
        Assert ($record.connectorid -eq '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps') 'Unexpected connector.'
        $record.connectionreferenceid = [guid]::NewGuid().ToString()
        $record.connectionid = $null
        $connectionReferences[$record.connectionreferencelogicalname] = $record
        $writes.Add("POST connectionreferences")
        return
    }
    if ($Method -eq 'POST' -and $path -eq 'workflows') {
        Assert $inAddOn 'The flow must be created in the add-on solution.'
        Assert (!$workflows.ContainsKey($record.name)) 'Duplicate workflow create.'
        Assert ($record.category -eq 5 -and $record.type -eq 1 -and $record.primaryentity -eq 'none') 'A cloud flow is category 5, type 1, primary entity none.'
        Assert (!$record.ContainsKey('statecode') -or $record.statecode -eq 0) 'The flow must be created switched off.'
        $record.workflowid = [guid]::NewGuid().ToString()
        $record.statecode = 0
        $workflows[$record.name] = $record
        $writes.Add("POST workflows")
        return
    }
    if ($Method -eq 'PATCH' -and $path -match '^workflows\(([\w-]+)\)$') {
        $id = $Matches[1]
        $flow = @($workflows.Values | Where-Object { $_.workflowid -eq $id })
        Assert ($flow.Count -eq 1) 'Updated an unknown workflow.'
        Assert (!$record.ContainsKey('statecode')) 'Updating the definition must not switch the flow on or off.'
        foreach ($key in $record.Keys) { $flow[0][$key] = $record[$key] }
        $writes.Add("PATCH workflows")
        return
    }
    throw "Unexpected request: $Method $path"
}

function Deploy {
    & $DeploymentScript -EnvUrl 'https://scheduler.invalid' -AccessToken 'mock' 6>&1 | Out-String
}

# First run creates exactly the solution, the connection reference and the flow.
$output = Deploy
Assert (($writes -join ',') -eq 'POST solutions,POST connectionreferences,POST workflows') "Unexpected first-run writes: $($writes -join ',')"
Assert ($output -match [regex]::Escape('Bind a Dataverse connection to asx_SchedulerDataverse in the maker portal, then turn the flow on.')) 'Expected the binding instruction while no connection is bound.'
$flow = $workflows['Rules Engine Scheduler']
Assert ($flow.statecode -eq 0) 'The flow must stay switched off without a bound connection.'

# The clientdata is the flow definition.
$clientData = $flow.clientdata | ConvertFrom-Json -AsHashtable
$reference = $clientData.properties.connectionReferences.shared_commondataserviceforapps
Assert ($reference.connection.connectionReferenceLogicalName -eq 'asx_SchedulerDataverse' -and $reference.api.name -eq 'shared_commondataserviceforapps') 'The flow must use the asx_SchedulerDataverse connection reference.'
$definition = $clientData.properties.definition
$trigger = $definition.triggers.Recurrence
Assert ($trigger.type -eq 'Recurrence' -and $trigger.recurrence.frequency -eq 'Minute' -and $trigger.recurrence.interval -eq 15) 'Expected a 15-minute recurrence.'
Assert ($trigger.runtimeConfiguration.concurrency.runs -eq 1) 'Expected one flow run at a time.'
function AllActions($Actions) {
    foreach ($name in $Actions.Keys) {
        $action = $Actions[$name]
        [pscustomobject]@{ Name = $name; Action = $action }
        foreach ($nested in @($action.actions, $action.else.actions)) { if ($nested) { AllActions $nested } }
    }
}
$actions = @{}
foreach ($entry in AllActions $definition.actions) { $actions[$entry.Name] = $entry.Action }
Assert ($definition.actions.Initialize_start.inputs.variables[0].value -match 'utcNow\(\)') 'Initialize_start must capture utcNow().'
foreach ($spec in @(@('Start_due_schedules', 'asx_StartDueSchedules'), @('Process_page', 'asx_ProcessRunPage'))) {
    $action = $actions[$spec[0]]
    Assert ($null -ne $action -and $action.type -eq 'OpenApiConnection') "Missing Dataverse action $($spec[0])."
    Assert ($action.inputs.host.operationId -eq 'PerformUnboundAction' -and $action.inputs.host.connectionName -eq 'shared_commondataserviceforapps') "$($spec[0]) must perform an unbound action."
    Assert ($action.inputs.parameters.actionName -ceq $spec[1]) "$($spec[0]) must call $($spec[1])."
}
Assert ($actions.Parse_run_ids.inputs -match "json\(.*outputs\('Start_due_schedules'\)\?\['body/RunIds'\]") 'Parse_run_ids must parse RunIds.'
$loop = $actions.For_each_run
Assert ($loop.type -eq 'Foreach' -and $loop.foreach -match 'Parse_run_ids' -and $loop.runtimeConfiguration.concurrency.repetitions -eq 1) 'Expected the runs driven one at a time.'
$until = @($actions.Values | Where-Object { $_.type -eq 'Until' })
Assert ($until.Count -eq 1 -and $until[0].limit.count -eq 500 -and $until[0].limit.timeout -eq 'PT12M') 'Expected one Until loop limited to 500 pages and 12 minutes.'
Assert ($until[0].expression -match "variables\('done'\)" -and $until[0].expression -match "addMinutes\(variables\('start'\), 12\)") 'The loop must stop when done or after the 12-minute budget.'
Assert ($null -ne $until[0].actions.Process_page) 'Process_page must run inside the loop.'
Assert (($actions.Process_page.inputs.parameters | ConvertTo-Json -Depth 10 -Compress) -match 'failedRecordId' ) 'Process_page must pass the failed record from the variables.'
$failure = @($until[0].actions.Values | Where-Object { $_.type -eq 'Scope' -and $_.runAfter.Process_page -contains 'Failed' })
Assert ($failure.Count -eq 1) 'Expected a failure scope after Process_page.'
$failureJson = $failure[0] | ConvertTo-Json -Depth 30 -Compress
Assert ($failureJson.Contains('asx_ProcessRunPage:record-failed:') -and $failureJson -match "body/error/message") 'The failure scope must recognise the record-failed marker.'
Assert ($failureJson -match "SetVariable" -and $failureJson -match "failedRecordId" -and $failureJson -match "failedMessage" -and $failureJson -match '"name":"done"') 'The failure scope must set the failed record or finish the run.'
$success = @($until[0].actions.Values | Where-Object { $_.type -eq 'Scope' -and $_.runAfter.Process_page -contains 'Succeeded' })
Assert ($success.Count -eq 1 -and ($success[0] | ConvertTo-Json -Depth 30 -Compress) -match 'body/Done') 'Expected the success scope to set done from body/Done.'
Write-Host 'PASS: first deployment creates the solution, connection reference and flow.'

# A second run changes nothing.
$writes.Clear()
Deploy | Out-Null
Assert ($writes.Count -eq 0) "A re-run must not write anything: $($writes -join ',')"
Write-Host 'PASS: deployment is idempotent.'

# A changed definition on the server is brought back to the source, without switching the flow.
$flow.clientdata = '{"properties":{},"schemaVersion":"1.0.0.0"}'
$flow.statecode = 1
$connectionReferences['asx_SchedulerDataverse'].connectionid = 'shared-commondataserviceforapps-1'
$writes.Clear()
$output = Deploy
Assert (($writes -join ',') -eq 'PATCH workflows') "Expected one definition update: $($writes -join ',')"
Assert (($flow.clientdata | ConvertFrom-Json -AsHashtable).properties.definition.triggers.Recurrence.recurrence.interval -eq 15) 'The definition was not restored.'
Assert ($flow.statecode -eq 1) 'An update must leave a switched-on flow on.'
Assert ($output -notmatch 'Bind a Dataverse connection') 'No binding instruction once a connection is bound.'
Write-Host 'PASS: a drifted definition is updated in place.'
