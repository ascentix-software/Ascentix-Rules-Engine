<#
.SYNOPSIS
  Upsert every web resource in the manifest into Dataverse, add net-new ones to the
  solution, and publish. Idempotent. -DryRun reports the plan without mutating.

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
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'

$base    = ($EnvUrl.TrimEnd('/')) + '/api/data/v9.2'
$headers = @{
  Authorization      = "Bearer $AccessToken"
  'OData-Version'    = '4.0'
  'OData-MaxVersion' = '4.0'
  Accept             = 'application/json'
}

$manifest    = Get-Content -Raw $ManifestPath | ConvertFrom-Json
$publishIds  = @()

foreach ($wr in $manifest) {
  if (-not (Test-Path $wr.path)) { throw "Missing web resource source file: $($wr.path)" }
  $contentB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wr.path))

  $filter  = [uri]::EscapeDataString("name eq '$($wr.name)'")
  $existing = Invoke-RestMethod -Method Get -Headers $headers `
    -Uri "$base/webresourceset?`$select=webresourceid&`$filter=$filter"

  if ($existing.value.Count -gt 0) {
    $id = $existing.value[0].webresourceid
    if ($DryRun) { Write-Host "[dryrun] update $($wr.name) ($id)"; $publishIds += $id; continue }
    $patch = @{ content = $contentB64 } | ConvertTo-Json
    Invoke-RestMethod -Method Patch -Headers $headers -ContentType 'application/json' `
      -Uri "$base/webresourceset($id)" -Body $patch | Out-Null
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
    $resp = Invoke-WebRequest -Method Post -Headers $headers -ContentType 'application/json' `
      -Uri "$base/webresourceset" -Body $create
    $hdrVal = $resp.Headers['OData-EntityId']
    if ($hdrVal -is [array]) { $hdrVal = $hdrVal[0] }
    $id = ($hdrVal -replace '.*\(([0-9a-fA-F-]+)\).*', '$1')
    Write-Host "[create] $($wr.name) ($id)"

    $addBody = @{
      ComponentId          = $id
      ComponentType        = 61
      SolutionUniqueName   = $SolutionName
      AddRequiredComponents = $false
    } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
      -Uri "$base/AddSolutionComponent" -Body $addBody | Out-Null
    Write-Host "[solution] added $($wr.name) to $SolutionName"
    $publishIds += $id
  }
}

if ($DryRun) { Write-Host "[dryrun] done (no changes made)"; return }

$wrXml   = ($publishIds | ForEach-Object { "<webresource>$_</webresource>" }) -join ''
$publish = @{ ParameterXml = "<importexportxml><webresources>$wrXml</webresources></importexportxml>" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Uri "$base/PublishXml" -Body $publish | Out-Null
Write-Host "[publish] published $($publishIds.Count) web resource(s)"
