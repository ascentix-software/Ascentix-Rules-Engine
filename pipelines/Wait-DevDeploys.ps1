<#
.SYNOPSIS
  Waits until no Plugin CI or Client CI run is queued or in progress, and no earlier live L2 run
  is in progress, so live L2 verifies what is actually deployed to DEV and has DEV to itself.

.DESCRIPTION
  Each CI pipeline queues L2 at the end of its own deploy (templates/queue-live-l2.yml). When a
  merge touches both the plugin and the client, the first CI to finish can start an L2 run
  while the other is still deploying, and that run tests the old build. Run first in the L2 job.

  Two L2 runs at once break each other: every test file sweeps the ZZ_RB_ rows it finds, the
  other run's included (2026-10-10: three merges in 90 s queued two runs, and one lost its
  data model mid-test). So a run also waits while a live L2 run with a lower build id is in
  progress. Lower ids only: two runs never wait on each other. Queued (not started) runs don't
  count, since one may be waiting for the agent this run holds.

  With -SkipIfVerified, a run that an earlier L2 run of the same commit already covered sets the
  pipeline variable liveL2AlreadyVerified=true, and the job skips the suite. A merge that touches
  the plugin and the client queues two runs: Plugin CI finishes first and its run waits for Client
  CI, so that run's suite starts after the deploy that queued the second one. An earlier run
  covers this one when it succeeded and its wait step finished after this run was queued.

  The pipelines are found by their YAML file, so the Azure DevOps and GitHub-sourced
  definitions both count. Fails open: with no matching definitions it returns at once, and
  after -TimeoutMinutes it logs a warning and returns (each CI queues its own L2 after its
  deploy anyway, so a stuck run delays verification instead of skipping it).
#>
param(
  [Parameter(Mandatory)] [string] $CollectionUri,
  [Parameter(Mandatory)] [string] $Project,
  [string] $AccessToken = $env:SYSTEM_ACCESSTOKEN,
  [string[]] $YamlFiles = @('pipelines/plugin-ci.yml', 'pipelines/client-ci.yml'),
  [string[]] $LiveL2YamlFiles = @('pipelines/client-live.yml'),
  # This run's build id; earlier L2 runs are the ones with a lower id. 0 skips the L2 wait.
  [int] $BuildId = [int]("0$env:BUILD_BUILDID"),
  [int] $TimeoutMinutes = 90,
  [int] $PollSeconds = 30,
  # Skip the suite when an earlier L2 run of the same commit already covered this run's deploy.
  # Off for the release gate, which must run its own suite.
  [switch] $SkipIfVerified,
  [string] $WaitStepName = 'Wait for CI deploys and earlier L2 runs to finish',
  # Seams for tests: GET a URI and return the parsed JSON; sleep N seconds; the current time.
  [scriptblock] $Get = { param($Uri, $Headers) Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers },
  [scriptblock] $Sleep = { param($Seconds) Start-Sleep -Seconds $Seconds },
  [scriptblock] $Now = { Get-Date }
)

$ErrorActionPreference = 'Stop'
$headers = @{ Authorization = "Bearer $AccessToken" }
$base = "$($CollectionUri.TrimEnd('/'))/$Project"
$normalize = { param($p) ($p -replace '\\', '/').TrimStart('/').ToLowerInvariant() }
$byYaml = {
  param($all, $files)
  $wanted = $files | ForEach-Object { & $normalize $_ }
  @($all | Where-Object { $_.process.yamlFilename -and ((& $normalize $_.process.yamlFilename) -in $wanted) })
}

$all = (& $Get "$base/_apis/build/definitions?includeAllProperties=true&`$top=500&api-version=7.1" $headers).value
$definitions = & $byYaml $all $YamlFiles
$liveL2 = if ($BuildId -gt 0) { & $byYaml $all $LiveL2YamlFiles } else { @() }
if (-not $definitions -and -not $liveL2) {
  Write-Host "No pipelines found for $(($YamlFiles + $LiveL2YamlFiles) -join ', '). Not waiting."
  return
}
$names = { param($defs) ($defs | ForEach-Object { "$($_.name) (#$($_.id))" }) -join ', ' }
if ($definitions) { Write-Host "Waiting on pipelines: $(& $names $definitions)." }
if ($liveL2) { Write-Host "Waiting on earlier runs of: $(& $names $liveL2) (this run is $BuildId)." }
$ids = ($definitions | ForEach-Object { $_.id }) -join ','
$l2Ids = ($liveL2 | ForEach-Object { $_.id }) -join ','

$deadline = (& $Now).AddMinutes($TimeoutMinutes)
while ($true) {
  $active = @(
    if ($ids) {
      foreach ($status in 'notStarted', 'inProgress') {
        (& $Get "$base/_apis/build/builds?definitions=$ids&statusFilter=$status&api-version=7.1" $headers).value
      }
    }
    if ($l2Ids) {
      (& $Get "$base/_apis/build/builds?definitions=$l2Ids&statusFilter=inProgress&api-version=7.1" $headers).value |
        Where-Object { $_ -and [int]$_.id -lt $BuildId }
    }
  ) | Where-Object { $_ }
  if ($active.Count -eq 0) {
    Write-Host 'No Plugin CI, Client CI or earlier L2 run is active.'
    break
  }
  $list = ($active | ForEach-Object { "$($_.definition.name) $($_.buildNumber) ($($_.status))" }) -join '; '
  if ((& $Now) -ge $deadline) {
    Write-Host "##vso[task.logissue type=warning]Still active after $TimeoutMinutes minutes: $list. Running L2 anyway."
    return
  }
  Write-Host "Active: $list. Checking again in $PollSeconds s."
  & $Sleep $PollSeconds
}

if ($SkipIfVerified -and $l2Ids) {
  $self = & $Get "$base/_apis/build/builds/$($BuildId)?api-version=7.1" $headers
  $queuedAt = [datetime]$self.queueTime
  $earlier = @((& $Get "$base/_apis/build/builds?definitions=$l2Ids&statusFilter=completed&resultFilter=succeeded&`$top=20&api-version=7.1" $headers).value |
    Where-Object { $_ -and [int]$_.id -lt $BuildId -and $_.sourceVersion -eq $self.sourceVersion })
  foreach ($run in $earlier) {
    $wait = (& $Get "$base/_apis/build/builds/$($run.id)/timeline?api-version=7.1" $headers).records |
      Where-Object { $_.type -eq 'Task' -and $_.name -eq $WaitStepName -and $_.finishTime } | Select-Object -First 1
    if ($wait -and [datetime]$wait.finishTime -gt $queuedAt) {
      Write-Host "L2 run $($run.buildNumber) (#$($run.id)) tested $($self.sourceVersion) after this run was queued. Skipping the suite."
      Write-Host '##vso[task.setvariable variable=liveL2AlreadyVerified]true'
      return
    }
  }
}
Write-Host 'Starting L2.'

