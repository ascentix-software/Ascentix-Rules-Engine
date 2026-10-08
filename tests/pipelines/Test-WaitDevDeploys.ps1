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

# The mocks keep their state in one global (this test runs in its own process), not in
# GetNewClosure copies or $script: (which means the Wait script while it calls them), so they
# behave the same on every PowerShell 7 version.
$get = {
  param($Uri, $Headers)
  $global:waitTest.calls.Add($Uri)
  if ($Uri -like '*/_apis/build/definitions*') { return $global:waitTest.definitions }
  # Each poll asks notStarted then inProgress: page i serves both of round i.
  $round = [math]::Floor($global:waitTest.page / 2); $global:waitTest.page++
  $builds = if ($round -lt $global:waitTest.pages.Count) { $global:waitTest.pages[$round] } else { @() }
  $status = if ($Uri -like '*statusFilter=notStarted*') { 'notStarted' } else { 'inProgress' }
  return @{ value = @($builds | Where-Object { $_.status -eq $status }) }
}
$sleep = { param($s) $global:waitTest.sleeps++; $global:waitTest.now = $global:waitTest.now.AddSeconds($s) }
$now = { $global:waitTest.now }

function Run([object[]] $BuildPages, [int] $Timeout = 45) {
  $global:waitTest = @{ calls = [System.Collections.Generic.List[string]]::new(); page = 0; sleeps = 0;
    now = [datetime]'2026-10-08T00:00:00Z'; pages = $BuildPages; definitions = $definitions }
  $output = & $script -CollectionUri 'https://dev.azure.com/org/' -Project 'proj' -AccessToken 't' `
    -TimeoutMinutes $Timeout -PollSeconds 60 -Get $get -Sleep $sleep -Now $now 6>&1 | Out-String
  return @{ calls = $global:waitTest.calls; sleeps = $global:waitTest.sleeps; output = $output }
}

$running = @{ status = 'inProgress'; buildNumber = 'plugin-ci-1'; definition = @{ name = 'Plugin CI' } }
$queued = @{ status = 'notStarted'; buildNumber = 'client-ci-7'; definition = @{ name = 'Client CI' } }

# Nothing active: no wait, and only the two CI definitions are polled.
$r = Run @()
Assert ($r.sleeps -eq 0) "Waited with nothing active. Output: $($r.output)"
Assert ($r.calls[1] -like '*definitions=3,4&statusFilter=notStarted*') "Polled the wrong definitions: $($r.calls[1]). Output: $($r.output)"
Assert ($r.output -like '*Starting L2*') 'Did not report starting L2.'

# Active for two rounds (in progress, then queued), then clear: waits twice.
$r = Run @(@($running), @($queued))
Assert ($r.sleeps -eq 2) "Expected 2 waits, got $($r.sleeps). Output: $($r.output)"
Assert ($r.output -like '*Plugin CI plugin-ci-1 (inProgress)*') 'Did not list the running build.'
Assert ($r.output -like '*Client CI client-ci-7 (notStarted)*') 'Did not list the queued build.'

# Still active at the deadline: warns and returns instead of failing.
$r = Run @(@($running), @($running), @($running), @($running)) -Timeout 2
Assert ($r.sleeps -eq 2) "Expected 2 waits before the deadline, got $($r.sleeps)."
Assert ($r.output -like '*##vso`[task.logissue type=warning`]Still active after 2 minutes*') 'No timeout warning.'

Write-Host 'PASS: Wait-DevDeploys waits for active Plugin/Client CI runs, finds them by YAML file, and fails open at the deadline.'
