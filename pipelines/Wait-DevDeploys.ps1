<#
.SYNOPSIS
  Waits until no Plugin CI or Client CI run is queued or in progress, so live L2 verifies
  what is actually deployed to DEV.

.DESCRIPTION
  Each CI pipeline queues L2 at the end of its own deploy (templates/queue-live-l2.yml). When a
  merge touches both the plugin and the client, the first CI to finish can start an L2 run
  while the other is still deploying, and that run tests the old build. Run first in the L2 job.

  The CI pipelines are found by their YAML file, so the Azure DevOps and GitHub-sourced
  definitions both count. Fails open: with no matching definitions it returns at once, and
  after -TimeoutMinutes it logs a warning and returns (each CI queues its own L2 after its
  deploy anyway, so a stuck run delays verification instead of skipping it).
#>
param(
  [Parameter(Mandatory)] [string] $CollectionUri,
  [Parameter(Mandatory)] [string] $Project,
  [string] $AccessToken = $env:SYSTEM_ACCESSTOKEN,
  [string[]] $YamlFiles = @('pipelines/plugin-ci.yml', 'pipelines/client-ci.yml'),
  [int] $TimeoutMinutes = 45,
  [int] $PollSeconds = 30,
  # Seams for tests: GET a URI and return the parsed JSON; sleep N seconds; the current time.
  [scriptblock] $Get = { param($Uri, $Headers) Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers },
  [scriptblock] $Sleep = { param($Seconds) Start-Sleep -Seconds $Seconds },
  [scriptblock] $Now = { Get-Date }
)

$ErrorActionPreference = 'Stop'
$headers = @{ Authorization = "Bearer $AccessToken" }
$base = "$($CollectionUri.TrimEnd('/'))/$Project"
$normalize = { param($p) ($p -replace '\\', '/').TrimStart('/').ToLowerInvariant() }
$wanted = $YamlFiles | ForEach-Object { & $normalize $_ }

$definitions = (& $Get "$base/_apis/build/definitions?includeAllProperties=true&`$top=500&api-version=7.1" $headers).value |
  Where-Object { $_.process.yamlFilename -and ((& $normalize $_.process.yamlFilename) -in $wanted) }
if (-not $definitions) {
  Write-Host "No pipelines found for $($YamlFiles -join ', '). Not waiting."
  return
}
$ids = ($definitions | ForEach-Object { $_.id }) -join ','
Write-Host "Waiting on pipelines: $(($definitions | ForEach-Object { "$($_.name) (#$($_.id))" }) -join ', ')."

$deadline = (& $Now).AddMinutes($TimeoutMinutes)
while ($true) {
  $active = @(foreach ($status in 'notStarted', 'inProgress') {
    (& $Get "$base/_apis/build/builds?definitions=$ids&statusFilter=$status&api-version=7.1" $headers).value
  }) | Where-Object { $_ }
  if ($active.Count -eq 0) {
    Write-Host 'No Plugin CI or Client CI run is active. Starting L2.'
    return
  }
  $list = ($active | ForEach-Object { "$($_.definition.name) $($_.buildNumber) ($($_.status))" }) -join '; '
  if ((& $Now) -ge $deadline) {
    Write-Host "##vso[task.logissue type=warning]Still active after $TimeoutMinutes minutes: $list. Running L2 anyway."
    return
  }
  Write-Host "Active: $list. Checking again in $PollSeconds s."
  & $Sleep $PollSeconds
}
