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
  # Poll round i (after i sleeps) serves page i: the builds of the asked definitions and status.
  $round = $global:waitTest.sleeps
  $builds = if ($round -lt $global:waitTest.pages.Count) { $global:waitTest.pages[$round] } else { @() }
  $defs = ([regex]::Match($Uri, 'definitions=([\d,]+)').Groups[1].Value -split ',') | ForEach-Object { [int]$_ }
  $status = [regex]::Match($Uri, 'statusFilter=(\w+)').Groups[1].Value
  return @{ value = @($builds | Where-Object { $_.status -eq $status -and $_.definition.id -in $defs }) }
}
$sleep = { param($s) $global:waitTest.sleeps++; $global:waitTest.now = $global:waitTest.now.AddSeconds($s) }
$now = { $global:waitTest.now }

function Run([object[]] $BuildPages, [int] $Timeout = 45, [int] $BuildId = 700) {
  $global:waitTest = @{ calls = [System.Collections.Generic.List[string]]::new(); sleeps = 0;
    now = [datetime]'2026-10-08T00:00:00Z'; pages = $BuildPages; definitions = $definitions }
  $output = & $script -CollectionUri 'https://dev.azure.com/org/' -Project 'proj' -AccessToken 't' `
    -BuildId $BuildId -TimeoutMinutes $Timeout -PollSeconds 60 -Get $get -Sleep $sleep -Now $now 6>&1 | Out-String
  return @{ calls = $global:waitTest.calls; sleeps = $global:waitTest.sleeps; output = $output }
}

$running = @{ id = 690; status = 'inProgress'; buildNumber = 'plugin-ci-1'; definition = @{ id = 3; name = 'Plugin CI' } }
$queued = @{ id = 691; status = 'notStarted'; buildNumber = 'client-ci-7'; definition = @{ id = 4; name = 'Client CI' } }
$earlierL2 = @{ id = 667; status = 'inProgress'; buildNumber = 'client-live-1'; definition = @{ id = 8; name = 'Live L2' } }
$laterL2 = @{ id = 701; status = 'inProgress'; buildNumber = 'client-live-3'; definition = @{ id = 8; name = 'Live L2' } }
$queuedL2 = @{ id = 666; status = 'notStarted'; buildNumber = 'client-live-0'; definition = @{ id = 8; name = 'Live L2' } }

# Nothing active: no wait; the two CI definitions and the live L2 definition are polled.
$r = Run @()
Assert ($r.sleeps -eq 0) "Waited with nothing active. Output: $($r.output)"
Assert ($r.calls[1] -like '*definitions=3,4&statusFilter=notStarted*') "Polled the wrong definitions: $($r.calls[1]). Output: $($r.output)"
Assert ($r.calls[3] -like '*definitions=8&statusFilter=inProgress*') "Did not poll live L2: $($r.calls[3]). Output: $($r.output)"
Assert ($r.output -like '*Starting L2*') 'Did not report starting L2.'

# CI active for two rounds (in progress, then queued), then clear: waits twice.
$r = Run @(@($running), @($queued))
Assert ($r.sleeps -eq 2) "Expected 2 waits, got $($r.sleeps). Output: $($r.output)"
Assert ($r.output -like '*Plugin CI plugin-ci-1 (inProgress)*') 'Did not list the running build.'
Assert ($r.output -like '*Client CI client-ci-7 (notStarted)*') 'Did not list the queued build.'

# An earlier L2 run in progress: waits until it finishes.
$r = Run @(@($earlierL2), @($earlierL2))
Assert ($r.sleeps -eq 2) "Expected 2 waits on the earlier L2, got $($r.sleeps). Output: $($r.output)"
Assert ($r.output -like '*Live L2 client-live-1 (inProgress)*') 'Did not list the earlier L2 run.'

# A later L2 run, or a queued earlier one, never holds this one up (no two runs wait on each other).
$r = Run @(@($laterL2, $queuedL2))
Assert ($r.sleeps -eq 0) "Waited on a later or queued L2 run. Output: $($r.output)"

# Without a build id (run by hand), only the CI pipelines are polled.
$r = Run @(@($earlierL2)) -BuildId 0
Assert ($r.sleeps -eq 0) "Waited on L2 without a build id. Output: $($r.output)"
Assert (-not ($r.calls | Where-Object { $_ -like '*definitions=8*' })) 'Polled live L2 without a build id.'

# Still active at the deadline: warns and returns instead of failing.
$r = Run @(@($running), @($running), @($running), @($running)) -Timeout 2
Assert ($r.sleeps -eq 2) "Expected 2 waits before the deadline, got $($r.sleeps)."
Assert ($r.output -like '*##vso`[task.logissue type=warning`]Still active after 2 minutes*') 'No timeout warning.'

Write-Host 'PASS: Wait-DevDeploys waits for active Plugin/Client CI runs and earlier in-progress L2 runs, finds them by YAML file, and fails open at the deadline.'
