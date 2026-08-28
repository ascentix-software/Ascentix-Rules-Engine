<#
.SYNOPSIS
  Update a registered Dataverse plugin assembly's content (secretless), then ensure a
  plugintype record exists for each type listed in the manifest. Idempotent.

  Replaces `pac plugin push` for the WIF/secretless model: the caller passes a
  pre-acquired Dataverse bearer token via -AccessToken (from an AzureCLI@2
  workload-identity-federation step). This script never handles secrets.

.NOTES
  The assembly must already be registered once in the target environment. First-time
  registration (creating the pluginassembly record) is a manual step (PRT / pac). This
  script only UPDATES the content of an existing assembly and reconciles its plugin types.
  Registering plugin *steps* for a genuinely new type remains manual (see docs/Plugin-Registration.md).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $DllPath,
  [Parameter(Mandatory)] [string] $EnvUrl,
  [Parameter(Mandatory)] [string] $AccessToken,
  [Parameter(Mandatory)] [string] $AssemblyName,
  [Parameter(Mandatory)] [string] $PluginTypesManifest
)
$ErrorActionPreference = 'Stop'

# Surface the Dataverse response body (the useful detail) on any Web API failure, then re-throw.
trap {
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { Write-Host "Dataverse error body: $($_.ErrorDetails.Message)" }
  break
}

if (-not (Test-Path $DllPath)) { throw "Plugin DLL not found: $DllPath" }

$base    = ($EnvUrl.TrimEnd('/')) + '/api/data/v9.2'
$headers = @{
  Authorization      = "Bearer $AccessToken"
  'OData-Version'    = '4.0'
  'OData-MaxVersion' = '4.0'
  Accept             = 'application/json'
}

# --- Resolve the existing assembly (first registration is manual) ---
$flt = [uri]::EscapeDataString("name eq '$AssemblyName'")
$asm = Invoke-RestMethod -Method Get -Headers $headers `
  -Uri "$base/pluginassemblies?`$select=pluginassemblyid&`$filter=$flt"
if ($asm.value.Count -eq 0) {
  throw "Plugin assembly '$AssemblyName' not found in $EnvUrl. Register it once (PRT / pac) before enabling CI updates."
}
$assemblyId = $asm.value[0].pluginassemblyid

# --- Update assembly content. Dataverse re-derives version/culture/publickeytoken from the
#     uploaded content, so we send ONLY content (version is system-managed; PATCHing it errors). ---
$dllFull    = (Resolve-Path $DllPath).Path
$contentB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($dllFull))
$patch = @{ content = $contentB64 } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Headers $headers -ContentType 'application/json' `
  -Uri "$base/pluginassemblies($assemblyId)" -Body $patch | Out-Null
Write-Host "[assembly] updated content for $AssemblyName ($assemblyId)"

# --- Ensure a plugintype record for each manifest type (net-new plugin type support) ---
# NB: plain assignment (no @()), because ConvertFrom-Json emits the array as a single pipeline
# object, and @(pipeline) would wrap it into one element instead of flattening.
$types = Get-Content -Raw $PluginTypesManifest | ConvertFrom-Json
foreach ($t in $types) {
  # GUIDs are unquoted in OData v4 filters; typename is a quoted string.
  $tf = [uri]::EscapeDataString("typename eq '$t' and _pluginassemblyid_value eq $assemblyId")
  $existing = Invoke-RestMethod -Method Get -Headers $headers `
    -Uri "$base/plugintypes?`$select=plugintypeid&`$filter=$tf"
  if ($existing.value.Count -gt 0) { Write-Host "[type] exists $t"; continue }

  $body = @{
    typename                        = $t
    name                            = $t
    friendlyname                    = ($t -split '\.')[-1]
    'pluginassemblyid@odata.bind'   = "/pluginassemblies($assemblyId)"
  } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
    -Uri "$base/plugintypes" -Body $body | Out-Null
  Write-Host "[type] created $t"
}
Write-Host "[done] reconciled assembly + $($types.Count) plugin type(s)"
