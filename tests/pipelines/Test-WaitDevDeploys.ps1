# Tests pipelines/Wait-DevDeploys.ps1 with the REST API, sleep and clock mocked.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\..\pipelines\Wait-DevDeploys.ps1'
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }

$definitions = @{ value = @(
  @{ id = 3; name = 'Plugin CI'; process = @{ yamlFilename = '/pipelines/plugin-ci.yml' } },
  @{ id = 4; name = 'Client CI'; process = @{ yamlFilename = 'pipelines\client-ci.yml' } },
  @{ id = 8; name = 'Live L2'; process = @{ yamlFilename = 'pipelines/client-live.yml' } },
  @{ id = 9; name = 'Classic'; process = @{ } }
) }

function Run([object[]] $BuildPages, [int] $Timeout = 45) {
  $state = @{ calls = [System.Collections.Generic.List[string]]::new(); page = 0; sleeps = 0; now = [datetime]'2026-10-08T00:00:00Z' }
  $get = {
    param($Uri, $Headers)
    $state.calls.Add($Uri)
    if ($Uri -like '*/_apis/build/definitions*') { return $definitions }
    # Each poll asks notStarted then inProgress: page i serves both of round i.
    $round = [math]::Floor($state.page / 2); $state.page++
    $builds = if ($round -lt $BuildPages.Count) { $BuildPages[$round] } else { @() }
    $status = if ($Uri -like '*statusFilter=notStarted*') { 'notStarted' } else { 'inProgress' }
    return @{ value = @($builds | Where-Object { $_.status -eq $status }) }
  }.GetNewClosure()
  $sleep = { param($s) $state.sleeps++; $state.now = $state.now.AddSeconds($s) }.GetNewClosure()
  $now = { $state.now }.GetNewClosure()
  $output = & $script -CollectionUri 'https://dev.azure.com/org/' -Project 'proj' -AccessToken 't' `
    -TimeoutMinutes $Timeout -PollSeconds 60 -Get $get -Sleep $sleep -Now $now 6>&1 | Out-String
  return @{ calls = $state.calls; sleeps = $state.sleeps; output = $output }
}

$running = @{ status = 'inProgress'; buildNumber = 'plugin-ci-1'; definition = @{ name = 'Plugin CI' } }
$queued = @{ status = 'notStarted'; buildNumber = 'client-ci-7'; definition = @{ name = 'Client CI' } }

# Nothing active: no wait, and only the two CI definitions are polled.
$r = Run @()
Assert ($r.sleeps -eq 0) 'Waited with nothing active.'
Assert ($r.calls[1] -like '*definitions=3,4&statusFilter=notStarted*') "Polled the wrong definitions: $($r.calls[1])"
Assert ($r.output -like '*Starting L2*') 'Did not report starting L2.'

# Active for two rounds (in progress, then queued), then clear: waits twice.
$r = Run @(@($running), @($queued))
Assert ($r.sleeps -eq 2) "Expected 2 waits, got $($r.sleeps)."
Assert ($r.output -like '*Plugin CI plugin-ci-1 (inProgress)*') 'Did not list the running build.'
Assert ($r.output -like '*Client CI client-ci-7 (notStarted)*') 'Did not list the queued build.'

# Still active at the deadline: warns and returns instead of failing.
$r = Run @(@($running), @($running), @($running), @($running)) -Timeout 2
Assert ($r.sleeps -eq 2) "Expected 2 waits before the deadline, got $($r.sleeps)."
Assert ($r.output -like '*##vso`[task.logissue type=warning`]Still active after 2 minutes*') 'No timeout warning.'

Write-Host 'PASS: Wait-DevDeploys waits for active Plugin/Client CI runs, finds them by YAML file, and fails open at the deadline.'
