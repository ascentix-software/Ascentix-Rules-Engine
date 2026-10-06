<#
.SYNOPSIS
    One-time conversion of every rule from On match / On no match to outcome-based "Fires when" trees.

.DESCRIPTION
    Run once per environment, right after upgrading to the release that introduces "Fires when"
    (see README.md next to this script). Uses only the public Web API:
      - a published rule (it has a published revision, or its status is Published) is edited through its
        working draft, opened with asx_OpenRuleDraft when it has none; a never-published rule is edited directly;
      - blank outcome names become "Outcome N" and duplicate names (ignoring case) get " (2)", " (3)", ...;
      - each action with asx_fireon set and no tree gets one:
          On match    -> root ALL with "<outcome> is true" for every outcome (no outcomes: an empty ALL, i.e. always);
          On no match -> root ANY with "<outcome> is false" for every outcome (no outcomes: the action never fired,
                         so it is deactivated and listed);
        then asx_fireon is cleared;
      - a rule that is enforcing (status Published) and whose draft changed is republished.
    Safe to re-run: actions without asx_fireon are left alone, tree rows get stable ids so an interrupted run is
    completed rather than duplicated, and a rule whose draft needed no change is not republished.
    Exit code 0 when no rule failed, 1 otherwise.

.PARAMETER EnvUrl
    The environment URL, for example https://contoso.crm.dynamics.com. Only its host name is printed.

.PARAMETER AccessToken
    A Dataverse bearer token for a System Administrator or System Customizer. Never printed.

.EXAMPLE
    ./Convert-RulesToOutcomes.ps1 -EnvUrl $url -AccessToken $token -WhatIf
#>
#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$EnvUrl,
    [Parameter(Mandatory)][string]$AccessToken
)
$ErrorActionPreference = 'Stop'

$PublishedStatus = 753840000
$OnMatch = 1
$OnNoMatch = 2
$All = 1
$Any = 2

$envUri = [uri]$EnvUrl
if (!$envUri.IsAbsoluteUri -or $envUri.Scheme -ne 'https') { throw 'EnvUrl must be an https URL, for example https://contoso.crm.dynamics.com.' }
$envHost = $envUri.Host
$base = $envUri.GetLeftPart([UriPartial]::Authority) + '/api/data/v9.2/'
$headers = @{ Authorization = "Bearer $AccessToken"; Accept = 'application/json'; 'OData-Version' = '4.0'; 'OData-MaxVersion' = '4.0' }
# PATCH is an upsert in Dataverse; If-Match: * makes every update fail rather than create a row.
$ifMatch = @{ 'If-Match' = '*' }
$cmdlet = $PSCmdlet
$dryRun = [bool]$WhatIfPreference
# Set while a published rule is only being inspected (no draft could be opened): nothing may be written.
$script:estimateOnly = $false

function Request([string]$Method, [string]$Path, $Body = $null, [hashtable]$Extra = $null) {
    $uri = if ($Path -match '^https://') { $Path } else { $base + $Path }
    $call = @{ Method = $Method; Uri = $uri; Headers = $(if ($Extra) { $headers + $Extra } else { $headers }) }
    if ($null -ne $Body) { $call.ContentType = 'application/json; charset=utf-8'; $call.Body = $Body | ConvertTo-Json -Depth 5 -Compress }
    try { Invoke-RestMethod @call }
    catch {
        $text = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        $message = try { ($text | ConvertFrom-Json).error.message } catch { $null }
        if (!$message) { $message = $text }
        $shown = if ($uri.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { $uri.Substring($base.Length) } else { '(next page)' }
        Write-Host "    request failed: $Method $($shown -replace '\?.*$', '')"
        throw [System.Exception]::new($message)
    }
}

# Every row of a query, following @odata.nextLink (only ever back to the same environment).
function GetAll([string]$Path) {
    $rows = [System.Collections.Generic.List[object]]::new()
    $next = $Path
    while ($next) {
        $page = Request GET $next
        foreach ($row in @($page.value)) { if ($null -ne $row) { $rows.Add($row) } }
        $next = $page.'@odata.nextLink'
        if ($next -and ([uri]$next).Host -ne $envHost) { throw 'Refusing a next-page link that points at another host.' }
    }
    $rows.ToArray()
}

# The same id for the same tree row on every run, so a re-run can tell its own partial work apart.
function StableId([string]$Key) {
    $hash = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes("asx-multi-outcome-2026-10/$Key".ToLowerInvariant()))
    [guid]::new([byte[]]$hash[0..15]).ToString()
}

function Change([string]$Target, [string]$Operation) {
    if ($script:estimateOnly) { return $false }
    $cmdlet.ShouldProcess($Target, $Operation)
}

# New names for the outcomes that need one: blank -> "Outcome N" (smallest N free), repeated -> "<name> (k)".
# Names compare trimmed and ignoring case, as the publish check does.
function Get-OutcomeRenames($Outcomes) {
    $taken = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($o in $Outcomes) { $name = "$($o.asx_name)".Trim(); if ($name) { [void]$taken.Add($name) } }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $renames = @{}
    foreach ($o in $Outcomes) {
        $name = "$($o.asx_name)".Trim()
        if (!$name) {
            $n = 1; while ($taken.Contains("Outcome $n")) { $n++ }
            $new = "Outcome $n"
        }
        elseif (!$seen.Add($name)) {
            $k = 2; while ($taken.Contains("$name ($k)")) { $k++ }
            $new = "$name ($k)"
        }
        else { continue }
        [void]$taken.Add($new); [void]$seen.Add($new)
        $renames[$o.asx_conditiongroupid] = $new
    }
    $renames
}

# Creates the action's root group (unless it exists from an interrupted run) and every missing test.
function Build-Tree($Action, $Outcomes, [bool]$RootExists, [string]$RuleName, [hashtable]$Names) {
    $id = $Action.asx_ruleactionid
    $onMatch = $Action.asx_fireon -eq $OnMatch
    $rootId = StableId "$id/root"
    $what = "action '$($Action.asx_name)' of rule '$RuleName'"
    $have = @()
    if ($RootExists) {
        $have = @(GetAll "asx_actionconditiontests?`$filter=_asx_actionconditiongroup_value eq $rootId&`$select=asx_actionconditiontestid" | ForEach-Object { $_.asx_actionconditiontestid })
    }
    elseif (Change $what "Create its Fires when root ($(if ($onMatch) { 'ALL' } else { 'ANY' }))") {
        Request POST 'asx_actionconditiongroups' @{
            asx_actionconditiongroupid = $rootId; asx_logicaloperator = $(if ($onMatch) { $All } else { $Any }); asx_order = 1
            'asx_RuleAction@odata.bind' = "/asx_ruleactions($id)"
        } | Out-Null
    }
    $order = 0
    foreach ($o in $Outcomes) {
        $order++
        $testId = StableId "$id/test/$($o.asx_conditiongroupid)"
        if ($have -contains $testId) { continue }
        if (Change $what "Add the test '$($Names[$o.asx_conditiongroupid])' is $(if ($onMatch) { 'true' } else { 'false' })") {
            Request POST 'asx_actionconditiontests' @{
                asx_actionconditiontestid = $testId; asx_expected = $onMatch; asx_order = $order
                'asx_ActionConditionGroup@odata.bind' = "/asx_actionconditiongroups($rootId)"
                'asx_Outcome@odata.bind' = "/asx_conditiongroups($($o.asx_conditiongroupid))"
            } | Out-Null
        }
    }
}

# Converts one rule's editable rows (its working draft, or the rule itself). Returns whether anything changed.
function Convert-Target([string]$Target, [string]$RuleName) {
    $changed = $false
    $outcomes = @(GetAll "asx_conditiongroups?`$filter=_asx_rule_value eq $Target and _asx_parentconditiongroup_value eq null and asx_isexecutioncondition eq false&`$select=asx_conditiongroupid,asx_name,createdon&`$orderby=createdon asc")
    $renames = Get-OutcomeRenames $outcomes
    $names = @{}
    foreach ($o in $outcomes) { $names[$o.asx_conditiongroupid] = $(if ($renames[$o.asx_conditiongroupid]) { $renames[$o.asx_conditiongroupid] } else { "$($o.asx_name)".Trim() }) }
    foreach ($o in $outcomes) {
        $new = $renames[$o.asx_conditiongroupid]
        if (!$new) { continue }
        $changed = $true
        if (Change "outcome '$($o.asx_name)' of rule '$RuleName'" "Rename it to '$new'") {
            Request PATCH "asx_conditiongroups($($o.asx_conditiongroupid))" @{ asx_name = $new } $ifMatch | Out-Null
        }
    }
    $actions = @(GetAll "asx_ruleactions?`$filter=_asx_rule_value eq $Target and asx_fireon ne null&`$select=asx_ruleactionid,asx_name,asx_fireon,asx_isactive")
    foreach ($action in $actions) {
        $id = $action.asx_ruleactionid
        if ($action.asx_fireon -notin @($OnMatch, $OnNoMatch)) { throw "Action '$($action.asx_name)' has an unknown asx_fireon value $($action.asx_fireon)." }
        $changed = $true
        $update = @{ asx_fireon = $null }
        $root = @((Request GET "asx_actionconditiongroups?`$filter=_asx_ruleaction_value eq $id and _asx_parentgroup_value eq null&`$select=asx_actionconditiongroupid&`$top=1").value | Where-Object { $null -ne $_ })
        if ($root.Count -gt 0) {
            # A tree already exists. Ours (stable id) may be incomplete after an interrupted run; anyone else's is kept as is.
            if ($root[0].asx_actionconditiongroupid -eq (StableId "$id/root")) { Build-Tree $action $outcomes $true $RuleName $names }
        }
        elseif ($action.asx_fireon -eq $OnMatch -or $outcomes.Count -gt 0) {
            Build-Tree $action $outcomes $false $RuleName $names
        }
        else {
            # On no match with no outcomes never fired; keep it that way.
            $update.asx_isactive = $false
        }
        $operation = if ($update.ContainsKey('asx_isactive')) { 'Deactivate it and clear On match / On no match' } else { 'Clear On match / On no match' }
        if (Change "action '$($action.asx_name)' of rule '$RuleName'" $operation) {
            Request PATCH "asx_ruleactions($id)" $update $ifMatch | Out-Null
        }
        if ($update.ContainsKey('asx_isactive')) { $deactivated.Add("$RuleName / $($action.asx_name)") }
    }
    $changed
}

$converted = [System.Collections.Generic.List[string]]::new()
$publishedRules = [System.Collections.Generic.List[string]]::new()
$deactivated = [System.Collections.Generic.List[string]]::new()
$withDraft = [System.Collections.Generic.List[string]]::new()
$opened = [System.Collections.Generic.List[string]]::new()
$failed = [System.Collections.Generic.List[string]]::new()

Write-Host "[migrate] Converting rules to outcome logic in $envHost$(if ($dryRun) { ' (-WhatIf: nothing is written)' })."
$allRules = @(GetAll 'asx_rules?$select=asx_ruleid,asx_name,statuscode,_asx_publishedrevision_value,_asx_draftof_value')
$draftOf = @{}
foreach ($r in $allRules) {
    if ($r._asx_draftof_value -and !$draftOf.ContainsKey($r._asx_draftof_value)) { $draftOf[$r._asx_draftof_value] = $r }
}
# Working drafts are converted with their rule.
$rules = @($allRules | Where-Object { !$_._asx_draftof_value } | Sort-Object asx_name, asx_ruleid)

foreach ($rule in $rules) {
    $label = "$($rule.asx_name) ($($rule.asx_ruleid))"
    $script:estimateOnly = $false
    try {
        $published = $null -ne $rule._asx_publishedrevision_value -or $rule.statuscode -eq $PublishedStatus
        $enforcing = $rule.statuscode -eq $PublishedStatus
        $target = $rule.asx_ruleid
        if ($published) {
            $draft = $draftOf[$rule.asx_ruleid]
            if ($draft) {
                $target = $draft.asx_ruleid
                $withDraft.Add($label)
            }
            elseif (Change "rule '$($rule.asx_name)'" 'Open a working draft') {
                $draftId = "$((Request POST 'asx_OpenRuleDraft' @{ RuleId = $rule.asx_ruleid }).DraftId)"
                if ($draftId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' -or $draftId -eq $rule.asx_ruleid) {
                    throw "asx_OpenRuleDraft did not return a working draft (got '$draftId')."
                }
                $target = $draftId
                $opened.Add($label)
            }
            else {
                # A declined -Confirm: leave the rule alone. -WhatIf: estimate from the rule's own rows, which the
                # draft would copy (nothing is written while estimateOnly is set).
                if (!$dryRun) { Write-Host "  $($label): skipped"; continue }
                $opened.Add($label)
                $script:estimateOnly = $true
            }
        }
        $changed = Convert-Target $target $rule.asx_name
        $note = if (!$changed) { 'no change' } elseif ($dryRun -or $script:estimateOnly) { 'would convert' } else { 'converted' }
        if ($changed) { $converted.Add($label) }
        if ($changed -and $published -and $enforcing) {
            if (Change "rule '$($rule.asx_name)'" 'Publish the converted working draft') {
                Request PATCH "asx_rules($target)" @{ statuscode = $PublishedStatus } $ifMatch | Out-Null
            }
            $publishedRules.Add($label)
            $note += $(if ($dryRun -or $script:estimateOnly) { ', would publish' } else { ', published' })
        }
        Write-Host "  $($label): $note"
    }
    catch {
        $message = $_.Exception.Message
        $failed.Add("Failed: $($rule.asx_ruleid) $($rule.asx_name): $message")
        Write-Host "  $($label): FAILED: $message"
    }
}
$script:estimateOnly = $false

function Show([string]$Heading, $Items) {
    Write-Host "  $Heading ($($Items.Count)):"
    foreach ($item in $Items) { Write-Host "    $item" }
}
Write-Host ''
Write-Host "Summary$(if ($dryRun) { ' (-WhatIf: nothing was written; the lists show what would change)' })"
Show 'Converted' $converted
Show 'Published' $publishedRules
Show 'Deactivated' $deactivated
Show 'Rules with a working draft' $withDraft
Show $(if ($dryRun) { 'Draft would be opened' } else { 'Drafts opened' }) $opened
Show 'Failed' $failed
if ($failed.Count -gt 0) { exit 1 }
exit 0
