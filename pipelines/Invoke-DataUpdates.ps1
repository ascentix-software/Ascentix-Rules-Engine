# Applies every pending data update in the target environment (docs/Schema.md §10), calling
# asx_ApplyDataUpdates until it reports Done. Run by plugin-ci after each plug-in deploy, before
# live L2. An item-failed error is reported back on the next call (the Rule Run protocol): its token
# (<update number>/<item>) is sent back as FailedItem exactly as received; any other error fails the
# pipeline. An update that completed with failures is a pipeline warning listing them.
param(
    [Parameter(Mandatory)][string]$EnvUrl,
    [Parameter(Mandatory)][string]$AccessToken,
    [int]$MaxCalls = 500
)
$ErrorActionPreference = 'Stop'
$uri = $EnvUrl.TrimEnd('/') + '/api/data/v9.2/asx_ApplyDataUpdates'
$headers = @{ Authorization = "Bearer $AccessToken"; Accept = 'application/json'; 'OData-Version' = '4.0'; 'OData-MaxVersion' = '4.0' }

$failed = $null
for ($call = 1; $call -le $MaxCalls; $call++) {
    $body = @{ Mode = 'Apply' }
    if ($failed) { $body.FailedItem = $failed.Item; $body.FailedMessage = $failed.Message }
    try {
        $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
    }
    catch {
        $text = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        $message = try { ($text | ConvertFrom-Json).error.message } catch { $text }
        if ($message -match 'asx_ApplyDataUpdates:item-failed:([^:\s]+):([\s\S]*)$') {
            $failed = @{ Item = $Matches[1]; Message = $Matches[2] }
            Write-Host "[data-updates] item $($failed.Item) failed: $($failed.Message)"
            continue
        }
        Write-Host "[data-updates] Apply failed: $message"
        throw
    }
    $failed = $null
    $latest = if ($result.Latest) { $result.Latest | ConvertFrom-Json } else { $null }
    if ($result.Done) {
        if ($latest -and $latest.status -eq 3) {
            Write-Host "##vso[task.logissue type=warning]Data update $($latest.number) ($($latest.title)) completed with $($latest.failed) failed item(s)."
            foreach ($f in $latest.failures) { Write-Host "  $($f.item): $($f.message)" }
        }
        Write-Host "[data-updates] Up to date (required: $($result.Required))."
        return
    }
}
throw "[data-updates] Data updates did not finish within $MaxCalls calls."
