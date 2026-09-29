<# Provision the optional scheduler add-on (its solution, connection reference and cloud flow) in an environment. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EnvUrl,
    [Parameter(Mandatory)][string]$AccessToken,
    [string]$SolutionName = 'AscentixRulesEngineScheduler',
    [string]$CoreSolutionName = 'AscentixRulesEngine',
    [string]$FlowPath = (Join-Path $PSScriptRoot 'RulesEngineScheduler.flow.json')
)
$ErrorActionPreference = 'Stop'
$base = $EnvUrl.TrimEnd('/') + '/api/data/v9.2'
$connectionReference = 'asx_SchedulerDataverse'
$connectorId = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps'
$flowName = 'Rules Engine Scheduler'
# -Outside leaves out the solution header: the add-on solution may not exist yet.
function Request([string]$Method, [string]$Path, $Body = $null, [switch]$Outside) {
    $headers = @{ Authorization = "Bearer $AccessToken"; Accept = 'application/json'; 'OData-Version' = '4.0'; 'OData-MaxVersion' = '4.0' }
    if (!$Outside) { $headers['MSCRM.SolutionUniqueName'] = $SolutionName }
    $args0 = @{ Method = $Method; Uri = "$base/$Path"; Headers = $headers }
    if ($null -ne $Body) { $args0.ContentType = 'application/json'; $args0.Body = $Body | ConvertTo-Json -Depth 30 -Compress }
    try { Invoke-RestMethod @args0 }
    catch {
        Write-Warning "[scheduler] request failed: $Method $Path"
        throw
    }
}
# Whitespace-insensitive form, so formatting alone never counts as a changed definition.
# (Objects, not -AsHashtable: they keep the property order stable across runs.)
function Normalize([string]$Json) { $Json | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress }

function EnsureSolution {
    $existing = Request GET "solutions?`$select=solutionid&`$filter=uniquename eq '$SolutionName'" -Outside
    if ($existing.value.Count -gt 0) { return }
    $core = Request GET "solutions?`$select=_publisherid_value&`$filter=uniquename eq '$CoreSolutionName'" -Outside
    if ($core.value.Count -ne 1) { throw "Install the $CoreSolutionName solution first: the add-on uses its publisher." }
    Request POST 'solutions' @{ uniquename = $SolutionName; friendlyname = 'Ascentix Rules Engine Scheduler'; version = '0.0.0.1';
        description = 'Optional scheduler for the Ascentix Rules Engine: a cloud flow that starts due rule schedules every 15 minutes and drives their runs.';
        'publisherid@odata.bind' = "/publishers($($core.value[0]._publisherid_value))" } -Outside | Out-Null
}
function EnsureConnectionReference {
    $query = "connectionreferences?`$select=connectionreferenceid,connectionid&`$filter=connectionreferencelogicalname eq '$connectionReference'"
    $existing = Request GET $query
    if ($existing.value.Count -gt 0) { return $existing.value[0] }
    Request POST 'connectionreferences' @{ connectionreferencelogicalname = $connectionReference;
        connectionreferencedisplayname = 'Rules Engine Scheduler Dataverse'; connectorid = $connectorId;
        description = 'Dataverse connection the Rules Engine Scheduler flow runs as.' } | Out-Null
    (Request GET $query).value[0]
}
function EnsureFlow {
    $clientData = Normalize (Get-Content -LiteralPath $FlowPath -Raw)
    $existing = Request GET "workflows?`$select=workflowid,clientdata,statecode&`$filter=name eq '$flowName' and category eq 5"
    if ($existing.value.Count -gt 1) { throw "Found more than one '$flowName' flow." }
    if ($existing.value.Count -eq 0) {
        # A new cloud flow is created switched off; it cannot run until a connection is bound.
        Request POST 'workflows' @{ name = $flowName; category = 5; type = 1; primaryentity = 'none'; clientdata = $clientData;
            description = 'Starts due rule schedules every 15 minutes and drives their runs.' } | Out-Null
        return (Request GET "workflows?`$select=workflowid,statecode&`$filter=name eq '$flowName' and category eq 5").value[0]
    }
    $flow = $existing.value[0]
    $current = if ($flow.clientdata) { Normalize $flow.clientdata } else { '' }
    if ($current -cne $clientData) { Request PATCH "workflows($($flow.workflowid))" @{ clientdata = $clientData } | Out-Null }
    $flow
}

EnsureSolution
$reference = EnsureConnectionReference
$flow = EnsureFlow
if (!$reference.connectionid) {
    Write-Host 'Bind a Dataverse connection to asx_SchedulerDataverse in the maker portal, then turn the flow on.'
} elseif ($flow.statecode -ne 1) {
    Write-Host "Turn the '$flowName' flow on in the maker portal."
}
Write-Host '[scheduler] add-on solution, connection reference and flow ready'
