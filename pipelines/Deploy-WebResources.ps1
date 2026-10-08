<#
.SYNOPSIS
  Upsert every web resource in the manifest into Dataverse, add net-new ones to the
  solution, and publish. Idempotent. -DryRun reports the plan without mutating.

  A manifest entry is either one file ({ path, name, displayName, type }) or a set of files
  ({ glob, namePrefix, displayPrefix, type }: each match becomes namePrefix + its file name,
  e.g. the guide's screenshots under asx_/docs/images/). Paths are relative to the repo root
  (the manifest's parent folder's parent). A web resource whose content is already current is
  left alone and not republished.

  Auth-agnostic: the caller passes a pre-acquired Dataverse bearer token via -AccessToken
  (in CI this comes from an AzureCLI@2 workload-identity-federation step; locally you can
  get one from Get-DataverseToken.ps1). This script never handles secrets.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ManifestPath,
  [Parameter(Mandatory)] [string] $EnvUrl,
  [Parameter(Mandatory)] [string] $AccessToken,
  [Parameter(Mandatory)] [string] $SolutionName,
  [switch] $DryRun,
  # Test seam: sends one Web API request and returns the parsed JSON body, plus the
  # OData-EntityId header for a create ({ Body, EntityId }).
  [scriptblock] $Send = {
    param($Method, $Uri, $Headers, $Body)
    if ($Method -eq 'Post' -and $Uri -like '*/webresourceset') {
      $resp = Invoke-WebRequest -Method Post -Headers $Headers -ContentType 'application/json' -Uri $Uri -Body $Body
      $id = $resp.Headers['OData-EntityId']; if ($id -is [array]) { $id = $id[0] }
      return @{ EntityId = $id }
    }
    $req = @{ Method = $Method; Headers = $Headers; Uri = $Uri }
    if ($Body) { $req.ContentType = 'application/json'; $req.Body = $Body }
    return @{ Body = Invoke-RestMethod @req }
  }
)
$ErrorActionPreference = 'Stop'

$base    = ($EnvUrl.TrimEnd('/')) + '/api/data/v9.2'
$headers = @{
  Authorization      = "Bearer $AccessToken"
  'OData-Version'    = '4.0'
  'OData-MaxVersion' = '4.0'
  Accept             = 'application/json'
}
$root = Split-Path -Parent (Split-Path -Parent (Resolve-Path $ManifestPath))

# Expand glob entries into one entry per file, sorted so runs are deterministic.
$entries = foreach ($wr in (Get-Content -Raw $ManifestPath | ConvertFrom-Json)) {
  if ($wr.glob) {
    $files = @(Get-ChildItem -Path (Join-Path $root $wr.glob) -File | Sort-Object Name)
    if ($files.Count -eq 0) { throw "No files match web resource glob: $($wr.glob)" }
    foreach ($f in $files) {
      [pscustomobject]@{ path = $f.FullName; name = "$($wr.namePrefix)$($f.Name)"; displayName = "$($wr.displayPrefix)$($f.Name)"; type = $wr.type }
    }
  } else {
    [pscustomobject]@{ path = (Join-Path $root $wr.path); name = $wr.name; displayName = $wr.displayName; type = $wr.type }
  }
}

$publishIds = @()
$unchanged  = 0
foreach ($wr in $entries) {
  if (-not (Test-Path $wr.path)) { throw "Missing web resource source file: $($wr.path)" }
  $contentB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wr.path))

  $filter   = [uri]::EscapeDataString("name eq '$($wr.name)'")
  $existing = (& $Send 'Get' "$base/webresourceset?`$select=webresourceid,content&`$filter=$filter" $headers $null).Body

  if ($existing.value.Count -gt 0) {
    $id = $existing.value[0].webresourceid
    if ($existing.value[0].content -eq $contentB64) { $unchanged++; continue }
    if ($DryRun) { Write-Host "[dryrun] update $($wr.name) ($id)"; $publishIds += $id; continue }
    $patch = @{ content = $contentB64 } | ConvertTo-Json
    & $Send 'Patch' "$base/webresourceset($id)" $headers $patch | Out-Null
    Write-Host "[update] $($wr.name) ($id)"
    $publishIds += $id
  }
  else {
    if ($DryRun) { Write-Host "[dryrun] create $($wr.name)"; continue }
    $create = @{
      name            = $wr.name
      displayname     = $wr.displayName
      webresourcetype = $wr.type
      content         = $contentB64
    } | ConvertTo-Json
    $hdrVal = (& $Send 'Post' "$base/webresourceset" $headers $create).EntityId
    $id = ($hdrVal -replace '.*\(([0-9a-fA-F-]+)\).*', '$1')
    Write-Host "[create] $($wr.name) ($id)"

    $addBody = @{
      ComponentId          = $id
      ComponentType        = 61
      SolutionUniqueName   = $SolutionName
      AddRequiredComponents = $false
    } | ConvertTo-Json
    & $Send 'Post' "$base/AddSolutionComponent" $headers $addBody | Out-Null
    Write-Host "[solution] added $($wr.name) to $SolutionName"
    $publishIds += $id
  }
}
Write-Host "[unchanged] $unchanged web resource(s) already current"

if ($DryRun) { Write-Host "[dryrun] done (no changes made)"; return }
if ($publishIds.Count -eq 0) { Write-Host "[publish] nothing changed, nothing to publish"; return }

$wrXml   = ($publishIds | ForEach-Object { "<webresource>$_</webresource>" }) -join ''
$publish = @{ ParameterXml = "<importexportxml><webresources>$wrXml</webresources></importexportxml>" } | ConvertTo-Json
& $Send 'Post' "$base/PublishXml" $headers $publish | Out-Null
Write-Host "[publish] published $($publishIds.Count) web resource(s)"
