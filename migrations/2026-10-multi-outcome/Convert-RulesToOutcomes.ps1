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
    Before it touches an enforcing rule that already has a working draft and would be republished, the script checks
    whether the draft was changed since the rule was last published (see "Draft-edit detection" in README.md). A draft with
    edits is listed under "Drafts with edits since the last publish" and its rule is skipped (nothing is written),
    unless -PublishDraftEdits is set. An enforcing rule with a draft but no published revision to compare is listed
    under "Drafts not checked" and converted and published as before. Under -WhatIf before the upgrade (the Fires
    when tables do not exist yet) every action is read as having no tree; a real run then stops at once.
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

.PARAMETER PublishDraftEdits
    Convert and publish enforcing rules whose working drafts have edits since the last publish, edits included,
    instead of skipping them. Use it once you have checked the drafts the previous run listed.

.EXAMPLE
    ./Convert-RulesToOutcomes.ps1 -EnvUrl $url -AccessToken $token -WhatIf
#>
#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$EnvUrl,
    [Parameter(Mandatory)][string]$AccessToken,
    [switch]$PublishDraftEdits
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

# -Quiet: a failure is not printed (the caller expects it may fail). The thrown exception carries the HTTP status
# in Data['Status'].
function Request([string]$Method, [string]$Path, $Body = $null, [hashtable]$Extra = $null, [switch]$Quiet) {
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
        if (!$Quiet) { Write-Host "    request failed: $Method $($shown -replace '\?.*$', '')" }
        $failure = [System.Exception]::new($message)
        $failure.Data['Status'] = $status
        throw $failure
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

# The rows of the rule's active published revision (asx_ReadPublishedRule), read once per rule and run.
$publishedRows = @{}
function Read-PublishedRows([string]$RuleId) {
    if ($publishedRows.ContainsKey($RuleId)) { return , $publishedRows[$RuleId] }
    $definition = (Request POST 'asx_ReadPublishedRule' @{ RuleId = $RuleId }).Definition
    $snapshot = "$definition" | ConvertFrom-Json
    if ($snapshot.Format -ne 1 -or $null -eq $snapshot.Rows) { throw 'asx_ReadPublishedRule returned a published revision in a format this script does not know.' }
    $rows = @(foreach ($row in $snapshot.Rows) { @{ Entity = "$($row.Entity)"; Id = "$($row.Id)".ToLowerInvariant(); Attributes = (Read-SnapshotAttributes $row.Attributes) } })
    $publishedRows[$RuleId] = $rows
    , $rows
}

# Whether the rule's active published revision still uses On match / On no match: an active action with
# asx_fireon set, or an active action with no Fires when tree. Such a rule needs its converted draft published,
# even when this run changed nothing (an earlier run failed or was stopped before the publish).
function Test-PublishedUnconverted([string]$RuleId) {
    $rows = Read-PublishedRows $RuleId
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

# ---------- Draft-edit detection ----------
# The parent -> child edges of a rule's configuration: the same list as RuleSnapshot.Edges in
# Ascentix.RulesEngine.Core/Publication/RuleSnapshot.cs (keep the two in step), as parent table, child table and the
# child's lookup to the parent. Its asx_tableconfig -> asx_tableconfig edge is left out: table configurations are the
# shared data model, not part of a rule's draft, so the walk never reads or follows them. Every table's Web API
# entity set is "<table>s" and its primary key "<table>id".
$DraftEdges = @(
    @('asx_rule', 'asx_conditiongroup', 'asx_rule'), @('asx_rule', 'asx_ruleaction', 'asx_rule'),
    @('asx_conditiongroup', 'asx_rulecondition', 'asx_conditiongroup'),
    @('asx_conditiongroup', 'asx_nodefiltergroup', 'asx_conditiongroup'),
    @('asx_rulecondition', 'asx_searchcriteriagroup', 'asx_rulecondition'),
    @('asx_rulecondition', 'asx_nodefiltergroup', 'asx_rulecondition'),
    @('asx_searchcriteriagroup', 'asx_searchcriterion', 'asx_criteriagroup'),
    @('asx_searchcriteriagroup', 'asx_searchcriteriagroup', 'asx_parentcriteriagroup'),
    @('asx_nodefiltergroup', 'asx_nodefiltergroup', 'asx_parentfiltergroup'),
    @('asx_nodefiltergroup', 'asx_nodefiltercriterion', 'asx_filtergroup'),
    @('asx_nodefiltercriterion', 'asx_nodefiltergroup', 'asx_owningcriterion'),
    @('asx_ruleaction', 'asx_localizedmessage', 'asx_ruleaction'),
    @('asx_ruleaction', 'asx_nodefiltergroup', 'asx_ruleaction'),
    @('asx_ruleaction', 'asx_actionconditiongroup', 'asx_ruleaction'),
    @('asx_actionconditiongroup', 'asx_actionconditiontest', 'asx_actionconditiongroup'))
# Parents per query: 50 "<lookup> eq <id>" clauses keep the URL well under the Web API's limit.
$DraftWalkBatch = 50
# After a Rule Builder publish, a draft row changed this long after the revision was created counts as edited (the
# publish itself updates the draft header in the same operation).
$PublishMarginSeconds = 120
# A row copied into a new draft (asx_OpenRuleDraft, Restore published to draft) changed this long after it was
# created counts as edited.
$CopyMarginSeconds = 5
# Such a copy is made by one plug-in operation, which Dataverse stops after 2 minutes: a draft row created later than
# this after the first one was added afterwards (a row deleted and another added keeps the counts equal).
$CopyWindowSeconds = 120

# A createdon/modifiedon value as UTC. Invoke-RestMethod turns Dataverse's "...Z" strings into UTC DateTimes.
function ConvertTo-Utc($Value) {
    if ($Value -is [datetime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) { return [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
        return $Value.ToUniversalTime()
    }
    if (!"$Value") { throw 'Dataverse returned a row without createdon or modifiedon.' }
    [datetimeoffset]::Parse("$Value", [cultureinfo]::InvariantCulture).UtcDateTime
}

# The Fires when tables (asx_actionconditiongroup, asx_actionconditiontest) arrive with the upgrade. A -WhatIf run
# before the upgrade reads every action as having no tree and leaves those tables out of the draft-edit check.
$TreeTables = @('asx_actionconditiongroup', 'asx_actionconditiontest')
$script:treeTablesMissing = $false
# Whether both Fires when tables exist, asked once per run. A missing table answers 404 (or "does not exist").
function Test-TreeTablesExist {
    foreach ($table in $TreeTables) {
        try { Request GET "${table}s?`$select=${table}id&`$top=1" -Quiet | Out-Null }
        catch {
            if ($script:tokenRejected) { throw }
            if ($_.Exception.Data['Status'] -eq 404 -or $_.Exception.Message -match 'does not exist|Resource not found') { return $false }
            throw
        }
    }
    $true
}

# The id of the action's Fires when root, if it has one.
function Get-RootId([string]$ActionId) {
    if ($script:treeTablesMissing) { return $null }
    $root = @((Request GET "asx_actionconditiongroups?`$filter=_asx_ruleaction_value eq $ActionId and _asx_parentgroup_value eq null&`$select=asx_actionconditiongroupid&`$top=1").value | Where-Object { $null -ne $_ })
    if ($root.Count -gt 0) { "$($root[0].asx_actionconditiongroupid)" }
}

# Every configuration row under the working draft (header excluded), found table by table along $DraftEdges, with
# its modifiedon and createdon.
function Get-DraftRows([string]$DraftId) {
    $rows = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $pending = @(@{ Entity = 'asx_rule'; Id = $DraftId })
    $edges = @($DraftEdges | Where-Object { !$script:treeTablesMissing -or $_[1] -notin $TreeTables })
    while ($pending.Count -gt 0) {
        $next = [System.Collections.Generic.List[object]]::new()
        foreach ($edge in $edges) {
            $parents = @($pending | Where-Object { $_.Entity -eq $edge[0] } | ForEach-Object { $_.Id })
            for ($start = 0; $start -lt $parents.Count; $start += $DraftWalkBatch) {
                $batch = $parents[$start..([Math]::Min($start + $DraftWalkBatch, $parents.Count) - 1)]
                $filter = ($batch | ForEach-Object { "_$($edge[2])_value eq $_" }) -join ' or '
                foreach ($row in GetAll "$($edge[1])s?`$filter=($filter)&`$select=$($edge[1])id,modifiedon,createdon") {
                    $id = "$($row."$($edge[1])id")".ToLowerInvariant()
                    if (!$seen.Add("$($edge[1])/$id")) { continue }
                    if ($seen.Count -gt 10000) { throw 'The working draft has more than 10,000 configuration rows.' }
                    $item = @{ Entity = $edge[1]; Id = $id; ModifiedOn = (ConvertTo-Utc $row.modifiedon); CreatedOn = (ConvertTo-Utc $row.createdon) }
                    $rows.Add($item); $next.Add($item)
                }
            }
        }
        $pending = $next.ToArray()
    }
    , $rows.ToArray()
}

function Format-Utc([datetime]$Value) { $Value.ToString('yyyy-MM-ddTHH:mm:ssZ', [cultureinfo]::InvariantCulture) }

# Why the enforcing rule's working draft counts as changed since the rule was last published, or $null when it does
# not. Compares the draft's rows with the published revision's (the asx_rule header and shared asx_tableconfig rows
# aside):
#  - Some draft row ids are the revision's (the draft was published from the Rule Builder, which keeps its row ids):
#    edited when a draft row is not in the revision, a revision row is missing from the draft, or a draft row (the
#    header included) was modified more than $PublishMarginSeconds after the revision was created.
#  - No draft row id is the revision's (the draft was opened after an in-place publish, or reset with Restore
#    published to draft): unchanged only when every table has as many rows as in the revision, every draft row was
#    created within $CopyWindowSeconds of the first (by the one operation that made the copy) and modified no more
#    than $CopyMarginSeconds after it was created, and the header was modified no more than $CopyWindowSeconds after
#    the last row was created (Restore updates the header right after it creates the rows).
# A draft that already holds a Fires when root this script created was checked by the run that created it (or
# that run had -PublishDraftEdits): the script's own writes are not edits, so it is not compared again.
function Get-DraftEdit($Rule, [string]$DraftId) {
    $draftRows = Get-DraftRows $DraftId
    $ourRoots = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in $draftRows | Where-Object { $_.Entity -eq 'asx_ruleaction' }) { [void]$ourRoots.Add((StableId "$($row.Id)/root")) }
    if (@($draftRows | Where-Object { $_.Entity -eq 'asx_actionconditiongroup' -and $ourRoots.Contains($_.Id) }).Count -gt 0) { return $null }

    $published = Read-PublishedRows $Rule.asx_ruleid
    $ignored = @('asx_rule', 'asx_tableconfig') + $(if ($script:treeTablesMissing) { $TreeTables } else { @() })
    $revisionRows = @($published | Where-Object { $_.Entity -notin $ignored })
    $revisionKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in $revisionRows) { [void]$revisionKeys.Add("$($row.Entity)/$($row.Id)") }
    $draftKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in $draftRows) { [void]$draftKeys.Add("$($row.Entity)/$($row.Id)") }
    $shared = @($draftRows | Where-Object { $revisionKeys.Contains("$($_.Entity)/$($_.Id)") }).Count
    if ($shared -gt 0) {
        $added = @($draftRows | Where-Object { !$revisionKeys.Contains("$($_.Entity)/$($_.Id)") })
        if ($added.Count -gt 0) { return "row added: $($added[0].Entity)" }
        $removed = @($revisionRows | Where-Object { !$draftKeys.Contains("$($_.Entity)/$($_.Id)") })
        if ($removed.Count -gt 0) { return "row removed: $($removed[0].Entity)" }
        $createdOn = ConvertTo-Utc (Request GET "asx_rulerevisions($($Rule._asx_publishedrevision_value))?`$select=createdon").createdon
        $header = ConvertTo-Utc (Request GET "asx_rules($DraftId)?`$select=modifiedon").modifiedon
        $limit = $createdOn.AddSeconds($PublishMarginSeconds)
        if ($header -gt $limit) { return "header modified $(Format-Utc $header)" }
        $late = @($draftRows | Where-Object { $_.ModifiedOn -gt $limit } | Sort-Object { $_.ModifiedOn })
        if ($late.Count -gt 0) { return "row modified $(Format-Utc $late[0].ModifiedOn): $($late[0].Entity)" }
        return $null
    }
    $draftCounts = @{}; foreach ($row in $draftRows) { $draftCounts[$row.Entity] = 1 + [int]$draftCounts[$row.Entity] }
    $revisionCounts = @{}; foreach ($row in $revisionRows) { $revisionCounts[$row.Entity] = 1 + [int]$revisionCounts[$row.Entity] }
    foreach ($table in @($draftCounts.Keys) + @($revisionCounts.Keys)) {
        if ([int]$draftCounts[$table] -ne [int]$revisionCounts[$table]) {
            return "row counts differ: $table (draft $([int]$draftCounts[$table]), published $([int]$revisionCounts[$table]))"
        }
    }
    if ($draftRows.Count -eq 0) { return $null }
    $byCreation = @($draftRows | Sort-Object { $_.CreatedOn })
    $copiedBy = $byCreation[0].CreatedOn.AddSeconds($CopyWindowSeconds)
    $later = @($byCreation | Where-Object { $_.CreatedOn -gt $copiedBy })
    if ($later.Count -gt 0) { return "row added $(Format-Utc $later[0].CreatedOn): $($later[0].Entity)" }
    $modified = @($draftRows | Where-Object { ($_.ModifiedOn - $_.CreatedOn).TotalSeconds -gt $CopyMarginSeconds } | Sort-Object { $_.ModifiedOn })
    if ($modified.Count -gt 0) { return "row modified $(Format-Utc $modified[0].ModifiedOn): $($modified[0].Entity)" }
    $header = ConvertTo-Utc (Request GET "asx_rules($DraftId)?`$select=modifiedon").modifiedon
    if ($header -gt $byCreation[-1].CreatedOn.AddSeconds($CopyWindowSeconds)) { return "header modified $(Format-Utc $header)" }
    $null
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
    $actions = @(GetAll "asx_ruleactions?`$filter=_asx_rule_value eq $Target and asx_fireon ne null&`$select=asx_ruleactionid,asx_name,asx_fireon,asx_isactive")
    foreach ($action in $actions) {
        $id = $action.asx_ruleactionid
        if ($action.asx_fireon -notin @($OnMatch, $OnNoMatch)) { throw "Action '$($action.asx_name)' has an unknown asx_fireon value $($action.asx_fireon)." }
        $changed = $true
        $update = @{ asx_fireon = $null }
        $rootId = Get-RootId $id
        if ($rootId) {
            # A tree already exists. Ours (stable id) may be incomplete after an interrupted run; anyone else's is kept as is.
            if ($rootId -eq (StableId "$id/root")) { Build-Tree $action $outcomes $true $RuleName $names }
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
    # Outcomes are renamed after the actions are converted (tests point at outcomes by id, so the order does not
    # change the result): a run stopped part-way has then already written one of its own Fires when roots, which
    # tells the next run's draft-edit check that this draft was checked before (see Get-DraftEdit).
    foreach ($o in $outcomes) {
        $new = $renames[$o.asx_conditiongroupid]
        if (!$new) { continue }
        $changed = $true
        if (Change "outcome '$($o.asx_name)' of rule '$RuleName'" "Rename it to '$new'") {
            Request PATCH "asx_conditiongroups($($o.asx_conditiongroupid))" @{ asx_name = $new } $ifMatch | Out-Null
        }
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
$draftEdits = [System.Collections.Generic.List[string]]::new()
$DraftEditsHeading = 'Drafts with edits since the last publish (skipped: publish or discard them, then re-run)'
$notChecked = [System.Collections.Generic.List[string]]::new()
$NotCheckedHeading = 'Drafts not checked (no published version to compare): review them by hand'

Write-Host "[migrate] Converting rules to outcome logic in $envHost$(if ($dryRun) { ' (-WhatIf: nothing is written)' })."
try { $script:treeTablesMissing = !(Test-TreeTablesExist) }
catch { Write-Host "Stopped: $($_.Exception.Message)"; exit 1 }
if ($script:treeTablesMissing) {
    if (!$dryRun) { Write-Host 'Upgrade the solution first: the Fires when tables are missing.'; exit 1 }
    Write-Host '  The Fires when tables are not in this environment yet (the solution is not upgraded): every action is read as having no Fires when condition.'
}
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
                # Before any write: an enforcing rule whose published version still uses On match / On no match is
                # republished from its existing draft, with everything in it, so a draft changed since the last
                # publish is left alone. That holds whatever the draft's actions look like: one converted by hand in
                # the Rule Builder keeps asx_fireon, and one with every action deleted has none left to convert. A
                # draft this script already converted is told apart inside Get-DraftEdit (its stable-id roots).
                if ($enforcing -and !$PublishDraftEdits) {
                    if ($null -eq $rule._asx_publishedrevision_value) {
                        # Published before revisions existed: there is no published version to compare the draft with.
                        # It is converted and published as before, and listed for the admin to review.
                        $notChecked.Add($label)
                    }
                    elseif (Test-PublishedUnconverted $rule.asx_ruleid) {
                        $edit = Get-DraftEdit $rule $target
                        if ($edit) {
                            $draftEdits.Add($label)
                            Write-Host "  $($label): skipped (its working draft has edits since the last publish: $edit)"
                            continue
                        }
                    }
                }
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
# First: the rules that need the admin before they can be converted.
if (!$PublishDraftEdits) {
    Show $DraftEditsHeading $draftEdits
    if ($draftEdits.Count -gt 0) {
        Write-Host '  Until these rules are converted and published, their actions do not fire (unless you already published a Fires when condition for them from the Rule Builder): the upgraded engine ignores On match / On no match. Open each of these rules in the Rule Builder and Publish or Discard its draft changes, then run the script again. Or, once you have checked them, run it again with -PublishDraftEdits to convert and publish them with their changes.'
    }
    Show $NotCheckedHeading $notChecked
    if ($notChecked.Count -gt 0) {
        Write-Host "  These rules were published before published versions were kept, so their drafts cannot be compared. Each $(if ($dryRun) { 'would be' } else { 'was' }) converted and published from its draft, with any saved but unpublished changes in it: open each and check that is what should be live."
    }
}
Show 'Converted' $converted
Show 'Published' $publishedRules
Show 'Deactivated' $deactivated
# Every rule ever published from the Rule Builder keeps a working draft, so this list is usually long.
$everyDraft = '  Every rule ever published from the Rule Builder keeps a working draft, so the next list includes all of them.'
if ($PublishDraftEdits) {
    Write-Host "$everyDraft With -PublishDraftEdits, drafts are not checked for changes: each enforcing rule published $(if ($dryRun) { 'would go' } else { 'went' }) live from its draft, with any saved but unpublished changes in it."
}
elseif ($dryRun) {
    Write-Host "$everyDraft Before converting an enforcing rule's draft, the script checks it for changes since the last publish and lists only the changed ones, first, under 'Drafts with edits since the last publish'. Publish or Discard those changes in the Rule Builder before the real run, or the real run skips those rules. An enforcing rule with no published version to compare is not checked: it is listed under 'Drafts not checked' and converted and published as it is."
}
else {
    Write-Host "$everyDraft Before converting an enforcing rule's draft, the script checked it for changes since the last publish; only the changed ones are listed, first, under 'Drafts with edits since the last publish', and those rules were left alone. An enforcing rule with no published version to compare was not checked: it is listed under 'Drafts not checked' and was converted and published as it is."
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
