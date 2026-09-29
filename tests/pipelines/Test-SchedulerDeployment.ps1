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
    # The loop re-drives a failed page and the next wake-up re-calls the API: a platform retry
    # would only repeat the same work inside the time budget.
    Assert ($action.inputs.retryPolicy.type -ceq 'none') "$($spec[0]) must not retry (retryPolicy none)."
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
Assert ($failureJson.Contains('asx_ProcessRunPage:record-failed:')) 'The failure scope must recognise the record-failed marker.'
# A plain-text or missing error body must not make the failure scope itself fail: read the body
# through actions() and only select properties once it is known to be an object.
Assert ($actions.Error_body.inputs -ceq "@coalesce(actions('Process_page')?['outputs']?['body'], '')") 'The error body must be read without assuming its shape.'
Assert ($actions.Read_error_text.type -eq 'If' -and ($actions.Read_error_text.expression | ConvertTo-Json -Depth 10 -Compress).Contains('startsWith')) 'Properties must only be selected from an object error body.'
Assert ($failureJson -notmatch 'body/error/message') 'The failure scope must not select error properties from a body of unknown shape.'
function SetsDoneTrue($Action) { $Action.type -eq 'SetVariable' -and $Action.inputs.name -eq 'done' -and $Action.inputs.value -eq $true }
Assert (@($actions.Is_record_failed.else.actions.Values | Where-Object { SetsDoneTrue $_ }).Count -eq 1) 'Any other error must leave the run for the next wake-up.'
$repeat = $actions.Is_repeat
Assert ($null -ne $repeat -and ($repeat.expression | ConvertTo-Json -Depth 10 -Compress) -match "outputs\('Failed_record_id'\)" -and ($repeat.expression | ConvertTo-Json -Depth 10 -Compress) -match "variables\('failedRecordId'\)") 'A repeated record-failed id must be recognised.'
Assert (($repeat.expression | ConvertTo-Json -Depth 10 -Compress).Contains("coalesce(variables('failedRecordId'), '')")) 'The repeat check must tolerate a null failedRecordId (the resets set it to null).'
Assert (@($repeat.actions.Values | Where-Object { SetsDoneTrue $_ }).Count -eq 1) 'A repeated record-failed id must stop driving the run.'
$fallback = @($until[0].actions.Values | Where-Object { $_.runAfter.Page_failed -contains 'Failed' -and $_.runAfter.Page_failed -contains 'TimedOut' })
Assert ($fallback.Count -eq 1 -and (SetsDoneTrue $fallback[0])) 'A failing failure scope must stop driving the run.'
Assert ($actions.Within_budget.type -eq 'If' -and $null -ne $actions.Within_budget.actions.Drive_run -and ($actions.Within_budget.expression | ConvertTo-Json -Depth 10 -Compress) -match "addMinutes\(variables\('start'\), 12\)") 'Runs must be skipped once the budget is spent.'
$success = @($until[0].actions.Values | Where-Object { $_.type -eq 'Scope' -and $_.runAfter.Process_page -contains 'Succeeded' })
Assert ($success.Count -eq 1 -and ($success[0] | ConvertTo-Json -Depth 30 -Compress) -match 'body/Done') 'Expected the success scope to set done from body/Done.'
foreach ($name in @('failedRecordId', 'failedMessage')) {
    Assert (@($success[0].actions.Values | Where-Object { $_.type -eq 'SetVariable' -and $_.inputs.name -eq $name -and $_.inputs.value -eq '@null' }).Count -eq 1) "The success scope must clear $name."
}

# Evaluate the flow's own extraction arithmetic on sample error texts.
Assert ($actions.Marker_at.inputs -match "^@indexOf\(variables\('errorText'\), '([^']+)'\)$") 'Unexpected marker search.'
$marker = $Matches[1]
Assert ($marker -ceq 'asx_ProcessRunPage:record-failed:') 'The marker must match the server contract.'
Assert (($actions.Is_record_failed.expression.and[1].greaterOrEquals[1]) -match "^@add\(outputs\('Marker_at'\), (\d+)\)$") 'Unexpected length guard.'
$minLength = [int]$Matches[1]
Assert ($actions.Failed_record_id.inputs -match "^@\{substring\(variables\('errorText'\), add\(outputs\('Marker_at'\), (\d+)\), (\d+)\)\}$") 'Unexpected record id extraction.'
$idStart = [int]$Matches[1]; $idLength = [int]$Matches[2]
Assert ($actions.Set_failed_message.inputs.value -match "add\(outputs\('Marker_at'\), (\d+)\)") 'Unexpected message extraction.'
$messageStart = [int]$Matches[1]
Assert ($actions.Set_failed_message.inputs.value -ceq "@{substring(variables('errorText'), min(add(outputs('Marker_at'), $messageStart), length(variables('errorText'))), max(0, sub(length(variables('errorText')), add(outputs('Marker_at'), $messageStart))))}") 'Unexpected message extraction.'
function Extract([string]$Text) {
    $at = $Text.IndexOf($marker, [StringComparison]::Ordinal)
    if (!($Text.Contains($marker) -and $Text.Length -ge $at + $minLength)) { return $null }
    $start = [Math]::Min($at + $messageStart, $Text.Length)
    @{ Id = $Text.Substring($at + $idStart, $idLength); Message = $Text.Substring($start, [Math]::Max(0, $Text.Length - ($at + $messageStart))) }
}
$sampleId = [guid]::NewGuid().ToString()
foreach ($sample in @(
    @("${marker}${sampleId}:Field X is required.", 'Field X is required.'),
    @("Plugin execution failed: ${marker}${sampleId}:Field X is required. (trace 42)", 'Field X is required. (trace 42)'),
    @("${marker}${sampleId}:", ''),
    @("${marker}${sampleId}", '')
)) {
    $parsed = Extract $sample[0]
    Assert ($null -ne $parsed -and $parsed.Id -ceq $sampleId -and $parsed.Message -ceq $sample[1]) "Wrong extraction from: $($sample[0])"
}
foreach ($sample in @('Gateway timeout', "${marker}1234")) { Assert ($null -eq (Extract $sample)) "Not a record failure: $sample" }
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
