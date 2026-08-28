<#
.SYNOPSIS
  Acquire a Dataverse access token using service-principal client credentials.
.OUTPUTS
  The bearer access token (string).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $ClientId,
  [Parameter(Mandatory)] [string] $ClientSecret,
  [Parameter(Mandatory)] [string] $ResourceUrl
)
$ErrorActionPreference = 'Stop'

$body = @{
  client_id     = $ClientId
  client_secret = $ClientSecret
  grant_type    = 'client_credentials'
  scope         = ($ResourceUrl.TrimEnd('/') + '/.default')
}
$resp = Invoke-RestMethod -Method Post `
  -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
  -ContentType 'application/x-www-form-urlencoded' -Body $body

if ([string]::IsNullOrWhiteSpace($resp.access_token)) {
  throw "Token endpoint returned no access_token."
}
return $resp.access_token
