<#
.SYNOPSIS
    One-time conversion of every rule from On match / On no match to outcome-based "Fires when" trees.

.DESCRIPTION
    Run once per environment, right after upgrading to the release that introduces "Fires when"
    (see README.md next to this script). Uses only the public Web API:
      - a rule with a published revision, Published status or a working draft is edited through its working
        draft, opened with asx_OpenRuleDraft when it has none; any other rule is edited directly;
      - blank outcome names become "Outcome N" and duplicate names (ignoring case) get " (2)", " (3)", ...;
      - each action with asx_fireon set and no tree gets one:
          On match    -> root ALL with "<outcome> is true" for every outcome (no outcomes: an empty ALL, i.e. always);
          On no match -> root ANY with "<outcome> is false" for every outcome (no outcomes: the action never fired,
                         so it is deactivated and listed);
        then asx_fireon is cleared;
      - a rule that is enforcing (status Published) is republished while its published revision
        (asx_ReadPublishedRule) still has an active action with asx_fireon set or without a tree.
    Safe to re-run, and a re-run finishes an interrupted one: actions without asx_fireon are left alone, tree rows
    get stable ids so a partial tree is completed rather than duplicated, and an enforcing rule whose publish
    failed or never happened is published by the next run. Under -Confirm, a rule with any declined write is
    not published and is listed under "Skipped (declined)".
    If Dataverse refuses the access token (HTTP 401, for example it expired), the run stops there with one
    message; get a new token and run it again.
    Exit code 0 when no rule failed, 1 otherwise (including a refused token).

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
# Set when Dataverse refuses the token (HTTP 401): every later request would fail the same way, so the run stops.
$script:tokenRejected = $false
$TokenMessage = 'The access token expired or is invalid; get a new token and re-run (the script resumes safely).'

function Request([string]$Method, [string]$Path, $Body = $null, [hashtable]$Extra = $null) {
    $uri = if ($Path -match '^https://') { $Path } else { $base + $Path }
    # -Verbose:$false: a -Verbose run must not print full request URLs.
    $call = @{ Method = $Method; Uri = $uri; Headers = $(if ($Extra) { $headers + $Extra } else { $headers }); Verbose = $false }
    if ($null -ne $Body) { $call.ContentType = 'application/json; charset=utf-8'; $call.Body = $Body | ConvertTo-Json -Depth 5 -Compress }
    try { Invoke-RestMethod @call }
    catch {
        $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
        if ($status -eq 401) { $script:tokenRejected = $true; throw [System.Exception]::new($TokenMessage) }
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

# Whether to make one write. -WhatIf says no without counting it as declined; a no under -Confirm marks the
# current rule as declined, so it is not published and is listed under "Skipped (declined)". The offline test
# stands in for the -Confirm prompt by defining Approve-RuleMigrationWrite before it calls this script.
function Change([string]$Target, [string]$Operation) {
    if ($script:estimateOnly) { return $false }
    $approved = if (!$dryRun -and (Test-Path function:Approve-RuleMigrationWrite)) { [bool](Approve-RuleMigrationWrite $Target $Operation) }
                else { $cmdlet.ShouldProcess($Target, $Operation) }
    if (!$approved -and !$dryRun) { $script:declined = $true }
    $approved
}

# The attributes of one snapshot row as a hashtable. DataContractJsonSerializer writes a dictionary as a list of
# { Key, Value } pairs; the object form is accepted too.
function Read-SnapshotAttributes($Attributes) {
    $map = @{}
    if ($Attributes -is [System.Array]) { foreach ($pair in $Attributes) { $map["$($pair.Key)"] = $pair.Value } }
    elseif ($null -ne $Attributes) { foreach ($p in $Attributes.PSObject.Properties) { $map[$p.Name] = $p.Value } }
    $map
}

# Whether the rule's active published revision still uses On match / On no match: an active action with
# asx_fireon set, or an active action with no Fires when tree. Such a rule needs its converted draft published,
# even when this run changed nothing (an earlier run failed or was stopped before the publish).
function Test-PublishedUnconverted([string]$RuleId) {
    $definition = (Request POST 'asx_ReadPublishedRule' @{ RuleId = $RuleId }).Definition
    $snapshot = "$definition" | ConvertFrom-Json
    if ($snapshot.Format -ne 1 -or $null -eq $snapshot.Rows) { throw 'asx_ReadPublishedRule returned a published revision in a format this script does not know.' }
    $rows = @(foreach ($row in $snapshot.Rows) { @{ Entity = "$($row.Entity)"; Id = "$($row.Id)"; Attributes = (Read-SnapshotAttributes $row.Attributes) } })
    $withTree = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in $rows | Where-Object { $_.Entity -eq 'asx_actionconditiongroup' }) {
        $action = $row.Attributes['asx_ruleaction']
        if ($action -and $action.Kind -eq 'reference' -and $action.Value) { [void]$withTree.Add("$($action.Value)") }
    }
    foreach ($row in $rows | Where-Object { $_.Entity -eq 'asx_ruleaction' }) {
        # Absent or null reads as false, as the engine reads it (GetAttributeValue<bool>).
        $active = $row.Attributes['asx_isactive']
        if (!($active -and $active.Kind -eq 'bool' -and "$($active.Value)" -eq 'true')) { continue }
        $fireOn = $row.Attributes['asx_fireon']
        if (($fireOn -and $fireOn.Kind -ne 'null') -or !$withTree.Contains($row.Id)) { return $true }
    }
    $false
}

# asx_conditiongroup.asx_name holds at most 100 characters (MaxLength in the shipped solution).
$MaxOutcomeName = 100
# "<base><suffix>", with the base shortened so the whole name fits the column.
function Fit-OutcomeName([string]$Base, [string]$Suffix) {
    $room = $MaxOutcomeName - $Suffix.Length
    if ($Base.Length -gt $room) { $Base = $Base.Substring(0, $room).TrimEnd() }
    "$Base$Suffix"
}

# New names for the outcomes that need one: blank -> "Outcome N" (smallest N free), repeated -> "<name> (k)"
# (the name shortened to fit the column). Names compare trimmed and ignoring case, as the publish check does.
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
            $k = 2; while ($taken.Contains((Fit-OutcomeName $name " ($k)"))) { $k++ }
            $new = Fit-OutcomeName $name " ($k)"
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
    elseif (!$dryRun) { return }  # root declined under -Confirm: its tests have nothing to hang on
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
    # A null "Run only when" flag reads as false in the engine (GetAttributeValue<bool>). Dataverse's "ne true" would
    # drop the null rows (SQL semantics), so ask for false or null explicitly.
    $outcomes = @(GetAll "asx_conditiongroups?`$filter=_asx_rule_value eq $Target and _asx_parentconditiongroup_value eq null and (asx_isexecutioncondition eq false or asx_isexecutioncondition eq null)&`$select=asx_conditiongroupid,asx_name,createdon&`$orderby=createdon asc")
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
        $approved = Change "action '$($action.asx_name)' of rule '$RuleName'" $operation
        if ($approved) { Request PATCH "asx_ruleactions($id)" $update $ifMatch | Out-Null }
        # Listed only when the deactivation was written (or, under -WhatIf, would be).
        if ($update.ContainsKey('asx_isactive') -and ($approved -or $dryRun)) { $deactivated.Add("$RuleName / $($action.asx_name)") }
    }
    $changed
}

$converted = [System.Collections.Generic.List[string]]::new()
$publishedRules = [System.Collections.Generic.List[string]]::new()
$deactivated = [System.Collections.Generic.List[string]]::new()
$withDraft = [System.Collections.Generic.List[string]]::new()
$opened = [System.Collections.Generic.List[string]]::new()
$failed = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[string]]::new()

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
    $script:declined = $false
    try {
        # As RuleDrafts.RequiresWorkingDraft: a rule with a published revision, Published status or a working draft
        # is edited only through its draft.
        $published = $null -ne $rule._asx_publishedrevision_value -or $rule.statuscode -eq $PublishedStatus -or $draftOf.ContainsKey($rule.asx_ruleid)
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
            elseif (!$dryRun) {
                # Declined under -Confirm: leave the rule alone.
                $skipped.Add($label)
                Write-Host "  $($label): skipped (declined)"
                continue
            }
            else {
                # -WhatIf: estimate from the rule's own rows, which the draft would copy (nothing is written while
                # estimateOnly is set).
                $opened.Add($label)
                $script:estimateOnly = $true
            }
        }
        $changed = Convert-Target $target $rule.asx_name
        if ($script:declined) {
            # Part of the conversion was declined: the draft is incomplete, so it is not offered for publishing.
            $skipped.Add($label)
            Write-Host "  $($label): skipped (declined); not published"
            continue
        }
        $would = $dryRun -or $script:estimateOnly
        $note = if (!$changed) { 'no change' } elseif ($would) { 'would convert' } else { 'converted' }
        if ($changed) { $converted.Add($label) }
        # An enforcing rule is republished while its published revision still uses On match / On no match, whether
        # or not this run changed its draft, so a run that failed or stopped before the publish is recovered. A
        # Published rule with no revision pointer (published before revisions) has no revision to read: the engine
        # runs it from its live rows, which still use On match / On no match, so it always needs publishing (that
        # publish gives it a pointer, so the next run reads its revision instead).
        $hasRevision = $null -ne $rule._asx_publishedrevision_value
        if ($enforcing -and (!$hasRevision -or (Test-PublishedUnconverted $rule.asx_ruleid))) {
            if (Change "rule '$($rule.asx_name)'" 'Publish the converted working draft') {
                Request PATCH "asx_rules($target)" @{ statuscode = $PublishedStatus } $ifMatch | Out-Null
            }
            if ($script:declined) {
                $skipped.Add($label)
                $note += ', publish declined'
            }
            else {
                $publishedRules.Add($label)
                $note += $(if ($would) { ', would publish' } else { ', published' })
            }
        }
        Write-Host "  $($label): $note"
    }
    catch {
        if ($script:tokenRejected) {
            # Not this rule's fault: stop here, and the re-run picks this rule up again.
            Write-Host "  $($label): stopped (access token refused)"
            break
        }
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
# Every rule ever published from the Rule Builder keeps a working draft, so this list is usually long.
if ($dryRun) {
    Write-Host '  Every rule ever published from the Rule Builder keeps a working draft, so the next list includes all of them. Before the real run, open any of these rules that has saved but unpublished changes and Publish or Discard them: the script republishes every enforcing rule''s draft, so those changes would go live with it.'
}
else {
    Write-Host '  Every rule ever published from the Rule Builder keeps a working draft, so the next list includes all of them. Each enforcing rule this run published went live from its draft, with any saved but unpublished changes in it.'
}
Show 'Rules with a working draft' $withDraft
Show $(if ($dryRun) { 'Draft would be opened' } else { 'Drafts opened' }) $opened
Show 'Skipped (declined)' $skipped
Show 'Failed' $failed
if ($script:tokenRejected) {
    Write-Host ''
    Write-Host "Stopped: $TokenMessage"
    exit 1
}
if ($failed.Count -gt 0) { exit 1 }
exit 0
