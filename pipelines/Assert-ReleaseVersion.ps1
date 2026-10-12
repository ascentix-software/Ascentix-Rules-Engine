<#
.SYNOPSIS
  Checks a solution-release version before the release spends time on the L2 gate.

.DESCRIPTION
  '0' is a non-release run and passes. Anything else must be four numbers (a Dataverse
  solution version) and higher than every v* release tag, because a managed upgrade rejects a
  version lower than the one already installed.
#>
param(
  [Parameter(Mandatory)] [string] $Version,
  # Seam for tests: the release tags, as git prints them.
  [scriptblock] $Tags = { git tag --list 'v*' }
)

$ErrorActionPreference = 'Stop'
$Version = $Version.Trim()
if ($Version -eq '0') {
  Write-Host 'Version 0: not a release (no version stamp, no tag).'
  return
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  throw "Version '$Version' is not four numbers, such as 0.1.0.2."
}

$wanted = [version]$Version
$released = @(& $Tags | ForEach-Object { "$_".Trim() } |
  Where-Object { $_ -match '^v\d+\.\d+\.\d+\.\d+$' } |
  ForEach-Object { [version]$_.Substring(1) } | Sort-Object)
if ($released.Count -eq 0) {
  Write-Host "No release tags found. Releasing $Version."
  return
}
$latest = $released[-1]
if ($wanted -le $latest) {
  throw "Version $Version is not higher than the latest release, v$latest. A managed upgrade would refuse it."
}
Write-Host "Releasing $Version (latest release: v$latest)."
