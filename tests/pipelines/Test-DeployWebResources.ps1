# Tests pipelines/Deploy-WebResources.ps1 with the Web API mocked: glob entries expand to one web
# resource per file, unchanged content is skipped (and not republished), changed content is
# patched, new files are created and added to the solution, and only changes are published.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\..\pipelines\Deploy-WebResources.ps1'
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
$b64 = { param($text) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }

# A throwaway repo: pipelines/webresources.json, one file, and a folder of images.
$root = Join-Path ([IO.Path]::GetTempPath()) ("wr-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path "$root/pipelines", "$root/client", "$root/docs/images" | Out-Null
[IO.File]::WriteAllText("$root/client/app.js", 'app v2')
[IO.File]::WriteAllText("$root/docs/images/a.png", 'png a')
[IO.File]::WriteAllText("$root/docs/images/b.png", 'png b')
@'
[
  { "path": "client/app.js", "name": "asx_/app.js", "displayName": "App", "type": 3 },
  { "glob": "docs/images/*.png", "namePrefix": "asx_/docs/images/", "displayPrefix": "Docs: ", "type": 5 }
]
'@ | Set-Content "$root/pipelines/webresources.json"

# State lives in a global: the mock runs inside the script under test (see Test-WaitDevDeploys.ps1).
function Run([hashtable] $Existing) {
  $global:wrTest = @{ existing = $Existing; calls = [System.Collections.Generic.List[object]]::new() }
  $send = {
    param($Method, $Uri, $Headers, $Body)
    $global:wrTest.calls.Add([pscustomobject]@{ Method = $Method; Uri = $Uri; Body = $Body })
    if ($Method -eq 'Get') {
      $name = [uri]::UnescapeDataString(($Uri -split '\$filter=')[1]) -replace "^name eq '(.*)'$", '$1'
      $hit = $global:wrTest.existing[$name]
      return @{ Body = [pscustomobject]@{ value = @(if ($hit) { [pscustomobject]@{ webresourceid = $hit.id; content = $hit.content } }) } }
    }
    if ($Method -eq 'Post' -and $Uri -like '*/webresourceset') { return @{ EntityId = "https://org/api/data/v9.2/webresourceset(11111111-1111-1111-1111-111111111111)" } }
    return @{ Body = $null }
  }
  $out = & $script -ManifestPath "$root/pipelines/webresources.json" -EnvUrl 'https://org' -AccessToken 't' -SolutionName 'Sol' -Send $send 6>&1 | Out-String
  return @{ calls = $global:wrTest.calls; out = $out }
}

try {
  # app.js changed, a.png current, b.png new.
  $r = Run @{
    'asx_/app.js'             = @{ id = 'app-id'; content = (& $b64 'app v1') }
    'asx_/docs/images/a.png'  = @{ id = 'a-id';   content = (& $b64 'png a') }
  }
  $gets = @($r.calls | Where-Object Method -eq 'Get')
  Assert ($gets.Count -eq 3) "Expected one lookup per web resource (3), got $($gets.Count)."
  Assert ([uri]::UnescapeDataString($gets[2].Uri) -like "*name eq 'asx_/docs/images/b.png'*") 'The glob did not name b.png under the prefix.'
  $patches = @($r.calls | Where-Object Method -eq 'Patch')
  Assert ($patches.Count -eq 1 -and $patches[0].Uri -like '*webresourceset(app-id)') 'Only the changed app.js should be patched.'
  $create = $r.calls | Where-Object { $_.Method -eq 'Post' -and $_.Uri -like '*/webresourceset' }
  Assert ($create -and ($create.Body | ConvertFrom-Json).displayname -eq 'Docs: b.png' -and ($create.Body | ConvertFrom-Json).webresourcetype -eq 5) 'b.png was not created as a PNG with its display name.'
  Assert ($r.calls | Where-Object { $_.Uri -like '*/AddSolutionComponent' }) 'The new web resource was not added to the solution.'
  $publish = $r.calls | Where-Object { $_.Uri -like '*/PublishXml' }
  $xml = ($publish.Body | ConvertFrom-Json).ParameterXml
  Assert ($xml -like '*app-id*' -and $xml -like '*11111111-1111-1111-1111-111111111111*' -and $xml -notlike '*a-id*') "Published the wrong set: $xml"
  Assert ($r.out -like '*1 web resource(s) already current*') 'Did not report the unchanged count.'

  # Everything current: no patch, no create, no publish.
  $r = Run @{
    'asx_/app.js'            = @{ id = 'app-id'; content = (& $b64 'app v2') }
    'asx_/docs/images/a.png' = @{ id = 'a-id';   content = (& $b64 'png a') }
    'asx_/docs/images/b.png' = @{ id = 'b-id';   content = (& $b64 'png b') }
  }
  Assert (@($r.calls | Where-Object Method -ne 'Get').Count -eq 0) 'Wrote or published although nothing changed.'
  Assert ($r.out -like '*nothing changed, nothing to publish*') 'Did not say there was nothing to publish.'

  Write-Host 'PASS: Deploy-WebResources expands globs, skips current content, and publishes only what changed.'
}
finally {
  Remove-Item -Recurse -Force $root
}
