# Tests pipelines/Assert-ReleaseVersion.ps1 with the release tags mocked.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\..\pipelines\Assert-ReleaseVersion.ps1'
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }

$tags = { 'v0.0.0.1'; 'v0.0.0.10'; 'not-a-release' }

function Check([string] $Version, [scriptblock] $TagList = $tags) {
  try {
    $output = & $script -Version $Version -Tags $TagList 6>&1 | Out-String
    return @{ ok = $true; output = $output }
  } catch {
    return @{ ok = $false; output = $_.Exception.Message }
  }
}

$r = Check '0'
Assert $r.ok "0 must pass as a non-release run: $($r.output)"
Assert ($r.output -like '*not a release*') "0 must say it isn't a release: $($r.output)"

# Compared as versions, not text: 0.0.0.10 is newer than 0.0.0.9, and 0.1.0.2 newer than both.
$r = Check '0.1.0.2'
Assert $r.ok "0.1.0.2 must pass above v0.0.0.10: $($r.output)"
Assert ($r.output -like '*latest release: v0.0.0.10*') "Must name the latest tag: $($r.output)"

$r = Check '0.0.0.9'
Assert (!$r.ok -and $r.output -like '*not higher than the latest release, v0.0.0.10*') "0.0.0.9 must be refused: $($r.output)"

$r = Check '0.0.0.10'
Assert (!$r.ok) "An existing release's version must be refused: $($r.output)"

foreach ($bad in @('0.1.0', '0.1.0.2.1', 'v0.1.0.2', 'beta')) {
  $r = Check $bad
  Assert (!$r.ok -and $r.output -like '*not four numbers*') "'$bad' must be refused as malformed: $($r.output)"
}

$r = Check '0.0.0.1' { }
Assert $r.ok "With no tags, any well-formed version passes: $($r.output)"

Write-Host 'PASS: Assert-ReleaseVersion passes 0, refuses malformed versions and any not above the latest v* tag.'
