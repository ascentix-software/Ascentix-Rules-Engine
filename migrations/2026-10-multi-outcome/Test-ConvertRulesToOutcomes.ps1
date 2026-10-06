# Runs Convert-RulesToOutcomes.ps1 against an in-memory Web API; no environment or credentials required.
# The mock answers only the exact request shapes the script sends and throws on anything else.
[CmdletBinding()]
param(
    [string]$MigrationScript = (Join-Path $PSScriptRoot 'Convert-RulesToOutcomes.ps1')
)
$ErrorActionPreference = 'Stop'
# The mock runs inside the script's scope (dynamic scoping), so its shared variables carry a prefix the script never uses.
$mockOrigin = 'https://migration.invalid/api/data/v9.2/'
$mockGuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
$mockPublished = 753840000

function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

# ---------- in-memory store ----------
function New-Store {
    @{ Rules = [System.Collections.Generic.List[hashtable]]::new(); Groups = [System.Collections.Generic.List[hashtable]]::new()
       Actions = [System.Collections.Generic.List[hashtable]]::new(); Trees = [System.Collections.Generic.List[hashtable]]::new()
       Tests = [System.Collections.Generic.List[hashtable]]::new(); Log = [System.Collections.Generic.List[string]]::new()
       Publishes = [System.Collections.Generic.List[string]]::new(); Opens = [System.Collections.Generic.List[string]]::new()
       FailPublish = @{}; FailTestCreateAt = 0; TestCreates = 0; Clock = 0 }
}
function NewId { [guid]::NewGuid().ToString() }
function Stamp { $db.Clock++; '2026-01-01T00:00:{0:00}Z' -f $db.Clock }
function AddRule([string]$Name, [int]$Status = 1, [bool]$Pointer = $false, [string]$DraftOf = $null) {
    $rule = @{ asx_ruleid = (NewId); asx_name = $Name; statuscode = $Status
        _asx_publishedrevision_value = $(if ($Pointer) { NewId } else { $null }); _asx_draftof_value = $DraftOf }
    $db.Rules.Add($rule); $rule
}
function AddGroup([string]$Rule, [string]$Name, [bool]$Execution = $false, [string]$Parent = $null) {
    $group = @{ asx_conditiongroupid = (NewId); _asx_rule_value = $Rule; asx_name = $Name; asx_isexecutioncondition = $Execution
        _asx_parentconditiongroup_value = $Parent; createdon = (Stamp) }
    $db.Groups.Add($group); $group
}
function AddAction([string]$Rule, [string]$Name, $FireOn) {
    $action = @{ asx_ruleactionid = (NewId); _asx_rule_value = $Rule; asx_name = $Name; asx_fireon = $FireOn; asx_isactive = $true }
    $db.Actions.Add($action); $action
}
# An author-built tree: a root ANY with one "is true" test on the given outcome.
function AddTree([string]$Action, [string]$Outcome) {
    $root = @{ asx_actionconditiongroupid = (NewId); _asx_ruleaction_value = $Action; _asx_parentgroup_value = $null; asx_logicaloperator = 2; asx_order = 1 }
    $db.Trees.Add($root)
    $db.Tests.Add(@{ asx_actionconditiontestid = (NewId); _asx_actionconditiongroup_value = $root.asx_actionconditiongroupid; _asx_outcome_value = $Outcome; asx_expected = $true; asx_order = 1 })
    $root
}
function RuleById([string]$Id) { @($db.Rules | Where-Object { $_.asx_ruleid -eq $Id })[0] }
function DraftOf([string]$Id) { @($db.Rules | Where-Object { $_._asx_draftof_value -eq $Id })[0] }
function GroupsOf([string]$Rule) { @($db.Groups | Where-Object { $_._asx_rule_value -eq $Rule }) }
function ActionsOf([string]$Rule) { @($db.Actions | Where-Object { $_._asx_rule_value -eq $Rule }) }
function ActionNamed([string]$Rule, [string]$Name) { @(ActionsOf $Rule | Where-Object { $_.asx_name -eq $Name })[0] }
function GroupNamed([string]$Rule, [string]$Name) { @(GroupsOf $Rule | Where-Object { $_.asx_name -ceq $Name })[0] }
function RootsOf([string]$Action) { @($db.Trees | Where-Object { $_._asx_ruleaction_value -eq $Action -and !$_._asx_parentgroup_value }) }
function TestsOf([string]$Group) { @($db.Tests | Where-Object { $_._asx_actionconditiongroup_value -eq $Group } | Sort-Object { $_.asx_order }) }
function Writes { @($db.Log | Where-Object { $_ -notmatch '^GET ' }) }

# What Dataverse returns: JSON objects, not hashtables.
function Respond($Value) { $Value | ConvertTo-Json -Depth 10 | ConvertFrom-Json }

# A Web API error as Invoke-RestMethod raises it: the Dataverse body is in ErrorDetails.
function Fail([int]$Status, [string]$Message) {
    $record = [System.Management.Automation.ErrorRecord]::new(
        [System.Exception]::new("Response status code does not indicate success: $Status."), 'WebCmdletWebResponseException',
        [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
    $record.ErrorDetails = [System.Management.Automation.ErrorDetails]::new((@{ error = @{ code = '0x80040265'; message = $Message } } | ConvertTo-Json -Compress))
    throw $record
}

# Writes to a rule that is (or was) published go through its working draft; the platform's guard refuses the rest.
function AssertEditable([string]$Rule) {
    $header = RuleById $Rule
    Assert ($null -ne $header) "Write to rows of an unknown rule $Rule."
    Assert ($header._asx_draftof_value -or (!$header._asx_publishedrevision_value -and $header.statuscode -ne $mockPublished)) "Direct write to the rows of published rule '$($header.asx_name)'."
}

# Copies a rule's rows into a new working draft with fresh ids, as asx_OpenRuleDraft does.
function OpenDraft([string]$RuleId) {
    $existing = DraftOf $RuleId
    if ($existing) { return $existing.asx_ruleid }
    $source = RuleById $RuleId
    $draft = AddRule $source.asx_name 1 $false $RuleId
    $map = @{}
    foreach ($g in GroupsOf $RuleId) { $map[$g.asx_conditiongroupid] = NewId }
    foreach ($g in GroupsOf $RuleId) {
        $copy = $g.Clone(); $copy.asx_conditiongroupid = $map[$g.asx_conditiongroupid]; $copy._asx_rule_value = $draft.asx_ruleid
        if ($g._asx_parentconditiongroup_value) { $copy._asx_parentconditiongroup_value = $map[$g._asx_parentconditiongroup_value] }
        $db.Groups.Add($copy)
    }
    foreach ($a in ActionsOf $RuleId) {
        $copy = $a.Clone(); $copy.asx_ruleactionid = NewId; $copy._asx_rule_value = $draft.asx_ruleid; $db.Actions.Add($copy)
        foreach ($root in RootsOf $a.asx_ruleactionid) {
            $rootCopy = $root.Clone(); $rootCopy.asx_actionconditiongroupid = NewId; $rootCopy._asx_ruleaction_value = $copy.asx_ruleactionid; $db.Trees.Add($rootCopy)
            foreach ($t in TestsOf $root.asx_actionconditiongroupid) {
                $testCopy = $t.Clone(); $testCopy.asx_actionconditiontestid = NewId
                $testCopy._asx_actionconditiongroup_value = $rootCopy.asx_actionconditiongroupid; $testCopy._asx_outcome_value = $map[$t._asx_outcome_value]
                $db.Tests.Add($testCopy)
            }
        }
    }
    $db.Opens.Add($RuleId)
    $draft.asx_ruleid
}

function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $ContentType, $Body)
    Assert ($Uri.StartsWith($mockOrigin)) "Unexpected request origin: $Uri"
    Assert ($Headers.Authorization -eq 'Bearer mock-token') 'Every request must carry the bearer token.'
    $path = [uri]::UnescapeDataString($Uri.Substring($mockOrigin.Length))
    $db.Log.Add("$Method $path")
    $record = if ($Body) { $Body | ConvertFrom-Json -AsHashtable } else { @{} }
    if ($Method -eq 'GET') {
        if ($path -match '^asx_rules\?\$select=asx_ruleid,asx_name,statuscode,_asx_publishedrevision_value,_asx_draftof_value(?:&\$skiptoken=(\d+))?$') {
            # Two rows a page, so the script must follow @odata.nextLink.
            $skip = if ($Matches[1]) { [int]$Matches[1] } else { 0 }
            $page = @{ value = @($db.Rules | Select-Object -Skip $skip -First 2 | ForEach-Object { $_.Clone() }) }
            if ($skip + 2 -lt $db.Rules.Count) { $page['@odata.nextLink'] = "${mockOrigin}asx_rules?`$select=asx_ruleid,asx_name,statuscode,_asx_publishedrevision_value,_asx_draftof_value&`$skiptoken=$($skip + 2)" }
            return Respond $page
        }
        if ($path -match "^asx_conditiongroups\?\`$filter=_asx_rule_value eq ($mockGuid) and _asx_parentconditiongroup_value eq null and asx_isexecutioncondition eq false&\`$select=asx_conditiongroupid,asx_name,createdon&\`$orderby=createdon asc$") {
            $rule = $Matches[1]
            return Respond @{ value = @(GroupsOf $rule | Where-Object { !$_._asx_parentconditiongroup_value -and !$_.asx_isexecutioncondition } |
                Sort-Object { $_.createdon } | ForEach-Object { @{ asx_conditiongroupid = $_.asx_conditiongroupid; asx_name = $_.asx_name; createdon = $_.createdon } }) }
        }
        if ($path -match "^asx_ruleactions\?\`$filter=_asx_rule_value eq ($mockGuid) and asx_fireon ne null&\`$select=asx_ruleactionid,asx_name,asx_fireon,asx_isactive$") {
            $rule = $Matches[1]
            return Respond @{ value = @(ActionsOf $rule | Where-Object { $null -ne $_.asx_fireon } | ForEach-Object {
                @{ asx_ruleactionid = $_.asx_ruleactionid; asx_name = $_.asx_name; asx_fireon = $_.asx_fireon; asx_isactive = $_.asx_isactive } }) }
        }
        if ($path -match "^asx_actionconditiongroups\?\`$filter=_asx_ruleaction_value eq ($mockGuid) and _asx_parentgroup_value eq null&\`$select=asx_actionconditiongroupid&\`$top=1$") {
            return Respond @{ value = @(RootsOf $Matches[1] | Select-Object -First 1 | ForEach-Object { @{ asx_actionconditiongroupid = $_.asx_actionconditiongroupid } }) }
        }
        if ($path -match "^asx_actionconditiontests\?\`$filter=_asx_actionconditiongroup_value eq ($mockGuid)&\`$select=asx_actionconditiontestid$") {
            return Respond @{ value = @(TestsOf $Matches[1] | ForEach-Object { @{ asx_actionconditiontestid = $_.asx_actionconditiontestid } }) }
        }
    }
    if ($Method -eq 'POST') {
        Assert (!$Headers.ContainsKey('If-Match')) "POST $path must not send If-Match."
        if ($path -eq 'asx_OpenRuleDraft') {
            Assert (@($record.Keys).Count -eq 1 -and $record.RuleId -match "^$mockGuid$") 'asx_OpenRuleDraft takes only RuleId.'
            $rule = RuleById $record.RuleId
            Assert ($rule -and !$rule._asx_draftof_value) 'asx_OpenRuleDraft must be called with a rule, not a draft.'
            return Respond @{ DraftId = (OpenDraft $record.RuleId) }
        }
        if ($path -eq 'asx_actionconditiongroups') {
            Assert ((@($record.Keys | Sort-Object) -join ',') -ceq 'asx_actionconditiongroupid,asx_logicaloperator,asx_order,asx_RuleAction@odata.bind') "Unexpected group body: $Body"
            Assert ($record.asx_logicaloperator -in @(1, 2) -and $record.asx_order -eq 1) 'A root group is ALL (1) or ANY (2) with order 1.'
            Assert ($record['asx_RuleAction@odata.bind'] -match "^/asx_ruleactions\(($mockGuid)\)$") 'Group must bind asx_RuleAction to /asx_ruleactions(<id>).'
            $action = @($db.Actions | Where-Object { $_.asx_ruleactionid -eq $Matches[1] })[0]
            Assert ($null -ne $action) 'Group bound to an unknown action.'
            AssertEditable $action._asx_rule_value
            Assert (@($db.Trees | Where-Object { $_.asx_actionconditiongroupid -eq $record.asx_actionconditiongroupid }).Count -eq 0) 'Duplicate group id.'
            Assert (@(RootsOf $action.asx_ruleactionid).Count -eq 0) 'A second root group for one action.'
            $db.Trees.Add(@{ asx_actionconditiongroupid = $record.asx_actionconditiongroupid; _asx_ruleaction_value = $action.asx_ruleactionid
                _asx_parentgroup_value = $null; asx_logicaloperator = $record.asx_logicaloperator; asx_order = $record.asx_order })
            return
        }
        if ($path -eq 'asx_actionconditiontests') {
            Assert ((@($record.Keys | Sort-Object) -join ',') -ceq 'asx_ActionConditionGroup@odata.bind,asx_actionconditiontestid,asx_expected,asx_order,asx_Outcome@odata.bind') "Unexpected test body: $Body"
            Assert ($record.asx_expected -is [bool]) 'asx_expected must be a boolean.'
            Assert ($record['asx_ActionConditionGroup@odata.bind'] -match "^/asx_actionconditiongroups\(($mockGuid)\)$") 'Test must bind asx_ActionConditionGroup.'
            $group = @($db.Trees | Where-Object { $_.asx_actionconditiongroupid -eq $Matches[1] })[0]
            Assert ($null -ne $group) 'Test bound to an unknown group.'
            Assert ($record['asx_Outcome@odata.bind'] -match "^/asx_conditiongroups\(($mockGuid)\)$") 'Test must bind asx_Outcome.'
            $outcome = @($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $Matches[1] })[0]
            $action = @($db.Actions | Where-Object { $_.asx_ruleactionid -eq $group._asx_ruleaction_value })[0]
            Assert ($outcome -and $outcome._asx_rule_value -eq $action._asx_rule_value -and !$outcome._asx_parentconditiongroup_value -and !$outcome.asx_isexecutioncondition) 'A test must point at an outcome of its own rule.'
            Assert (@($db.Tests | Where-Object { $_.asx_actionconditiontestid -eq $record.asx_actionconditiontestid }).Count -eq 0) 'Duplicate test id.'
            $db.TestCreates++
            if ($db.TestCreates -eq $db.FailTestCreateAt) { Fail 500 'Simulated interruption while creating a test.' }
            $db.Tests.Add(@{ asx_actionconditiontestid = $record.asx_actionconditiontestid; _asx_actionconditiongroup_value = $group.asx_actionconditiongroupid
                _asx_outcome_value = $outcome.asx_conditiongroupid; asx_expected = $record.asx_expected; asx_order = $record.asx_order })
            return
        }
    }
    if ($Method -eq 'PATCH') {
        # PATCH is an upsert in Dataverse; If-Match: * makes it update-only.
        Assert ($Headers['If-Match'] -eq '*') "PATCH $path must send If-Match: *."
        if ($path -match "^asx_conditiongroups\(($mockGuid)\)$") {
            $group = @($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $Matches[1] })[0]
            Assert ($null -ne $group) 'Rename of an unknown group.'
            Assert ((@($record.Keys) -join ',') -eq 'asx_name' -and ![string]::IsNullOrWhiteSpace($record.asx_name)) 'A group update sets only a non-blank asx_name.'
            AssertEditable $group._asx_rule_value
            $group.asx_name = $record.asx_name
            return
        }
        if ($path -match "^asx_ruleactions\(($mockGuid)\)$") {
            $action = @($db.Actions | Where-Object { $_.asx_ruleactionid -eq $Matches[1] })[0]
            Assert ($null -ne $action) 'Update of an unknown action.'
            Assert ($record.ContainsKey('asx_fireon') -and $null -eq $record.asx_fireon) 'An action update must clear asx_fireon.'
            Assert (@($record.Keys | Where-Object { $_ -notin @('asx_fireon', 'asx_isactive') }).Count -eq 0) "Unexpected action body: $Body"
            if ($record.ContainsKey('asx_isactive')) { Assert ($record.asx_isactive -eq $false) 'Only deactivation is expected.' }
            AssertEditable $action._asx_rule_value
            foreach ($key in $record.Keys) { $action[$key] = $record[$key] }
            return
        }
        if ($path -match "^asx_rules\(($mockGuid)\)$") {
            $id = $Matches[1]
            $rule = RuleById $id
            Assert ($rule -and $rule._asx_draftof_value) 'Only a working draft is published.'
            Assert ((@($record.Keys) -join ',') -eq 'statuscode' -and $record.statuscode -eq $mockPublished) 'Publishing sets only statuscode 753840000.'
            if ($db.FailPublish.ContainsKey($id)) { Fail 400 $db.FailPublish[$id] }
            # The working copy stays a Draft; the original's active snapshot switches.
            $db.Publishes.Add($rule._asx_draftof_value)
            return
        }
    }
    throw "Unexpected request: $Method $path"
}

function Run([switch]$WhatIf) {
    $global:LASTEXITCODE = 0
    $output = & $MigrationScript -EnvUrl 'https://migration.invalid/' -AccessToken 'mock-token' -WhatIf:$WhatIf 6>&1 2>&1 | Out-String
    @{ Output = $output; ExitCode = $LASTEXITCODE }
}
# The lines listed under a summary heading, up to the next heading.
function Section([string]$Output, [string]$Heading) {
    $lines = $Output -split "`r?`n"
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$([regex]::Escape($Heading)) \(\d+\):") { $start = $i; break } }
    if ($start -lt 0) { return , @() }
    $items = @()
    for ($i = $start + 1; $i -lt $lines.Count -and $lines[$i] -match '^\s{4,}\S'; $i++) { $items += $lines[$i].Trim() }
    , $items
}

# ---------- fixtures ----------
function Seed {
    $script:db = New-Store
    $f = @{}
    # 1. Never-published rule.
    $r1 = AddRule 'R1 never published'
    $f.R1 = $r1.asx_ruleid
    $f.G1 = (AddGroup $r1.asx_ruleid '').asx_conditiongroupid
    $f.Exec = (AddGroup $r1.asx_ruleid '' $true).asx_conditiongroupid
    $f.G2 = (AddGroup $r1.asx_ruleid 'Big').asx_conditiongroupid
    $f.Nested = (AddGroup $r1.asx_ruleid '' $false $f.G2).asx_conditiongroupid
    $f.G3 = (AddGroup $r1.asx_ruleid 'big').asx_conditiongroupid
    $f.A1 = (AddAction $r1.asx_ruleid 'A1' 1).asx_ruleactionid
    $f.A2 = (AddAction $r1.asx_ruleid 'A2' 2).asx_ruleactionid
    $a3 = AddAction $r1.asx_ruleid 'A3' $null
    $f.A3 = $a3.asx_ruleactionid; $f.A3Root = (AddTree $a3.asx_ruleactionid $f.G2).asx_actionconditiongroupid
    # An action with asx_fireon still set but an author-built tree: keep the tree, clear asx_fireon.
    $a4 = AddAction $r1.asx_ruleid 'A4' 1
    $f.A4 = $a4.asx_ruleactionid; $f.A4Root = (AddTree $a4.asx_ruleactionid $f.G3).asx_actionconditiongroupid
    # 2. Published rule without a working draft.
    $p1 = AddRule 'P1 published no draft' $mockPublished $true
    $f.P1 = $p1.asx_ruleid
    AddGroup $p1.asx_ruleid 'Valid' | Out-Null
    AddAction $p1.asx_ruleid 'Notify' 1 | Out-Null
    # 3. Published rule whose existing draft is already converted.
    $p2 = AddRule 'P2 draft converted' $mockPublished $true
    $f.P2 = $p2.asx_ruleid
    $d2 = AddRule $p2.asx_name 1 $false $p2.asx_ruleid
    $f.D2 = $d2.asx_ruleid
    $d2Outcome = AddGroup $d2.asx_ruleid 'Done'
    $d2Action = AddAction $d2.asx_ruleid 'Notify' $null
    AddTree $d2Action.asx_ruleactionid $d2Outcome.asx_conditiongroupid | Out-Null
    # 4. Published rule whose draft has no outcomes.
    $p3 = AddRule 'P3 no outcomes' $mockPublished $true
    $f.P3 = $p3.asx_ruleid
    $d3 = AddRule $p3.asx_name 1 $false $p3.asx_ruleid
    $f.D3 = $d3.asx_ruleid
    AddGroup $d3.asx_ruleid 'Run only when' $true | Out-Null
    AddAction $d3.asx_ruleid 'Always set' 1 | Out-Null
    AddAction $d3.asx_ruleid 'Never fired' 2 | Out-Null
    # 5. Published rule whose publish fails.
    $p4 = AddRule 'P4 publish fails' $mockPublished $true
    $f.P4 = $p4.asx_ruleid
    $d4 = AddRule $p4.asx_name 1 $false $p4.asx_ruleid
    $f.D4 = $d4.asx_ruleid
    AddGroup $d4.asx_ruleid 'Amount' | Out-Null
    AddAction $d4.asx_ruleid 'Block' 2 | Out-Null
    $db.FailPublish[$d4.asx_ruleid] = 'The rule has a lookup filter that points at a missing column.'
    # 6. Published once, currently unpublished (pointer set, Draft status), no draft. Sorted after P4.
    $u1 = AddRule 'U1 unpublished' 1 $true
    $f.U1 = $u1.asx_ruleid
    AddGroup $u1.asx_ruleid 'Has phone' | Out-Null
    AddAction $u1.asx_ruleid 'Set flag' 1 | Out-Null
    $f
}

# ---------- RED check ----------
Assert (Test-Path $MigrationScript) "Migration script not found: $MigrationScript"

# ---------- first run ----------
$f = Seed
$first = Run
$out = $first.Output

# 1. Never-published rule R1 converts in place.
Assert ((@($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $f.G1 })[0]).asx_name -eq 'Outcome 1') '1: blank outcome G1 must be named "Outcome 1".'
Assert ((@($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $f.G2 })[0]).asx_name -ceq 'Big') '1: G2 "Big" keeps its name.'
Assert ((@($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $f.G3 })[0]).asx_name -ceq 'big (2)') '1: duplicate G3 "big" must become "big (2)".'
Assert ((@($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $f.Exec })[0]).asx_name -eq '') '1: an execution-condition group is not an outcome and is not renamed.'
Assert ((@($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $f.Nested })[0]).asx_name -eq '') '1: a nested group is not an outcome and is not renamed.'
foreach ($case in @(@('A1', 1, $true), @('A2', 2, $false))) {
    $roots = @(RootsOf $f[$case[0]])
    Assert ($roots.Count -eq 1 -and $roots[0].asx_logicaloperator -eq $case[1] -and $roots[0].asx_order -eq 1) "1: $($case[0]) must get one root with operator $($case[1])."
    $tests = @(TestsOf $roots[0].asx_actionconditiongroupid)
    Assert ((($tests | ForEach-Object { $_._asx_outcome_value }) -join ',') -eq (@($f.G1, $f.G2, $f.G3) -join ',')) "1: $($case[0]) must test G1, G2, G3 in order."
    Assert (@($tests | Where-Object { $_.asx_expected -ne $case[2] }).Count -eq 0) "1: $($case[0]) tests must all expect $($case[2])."
    Assert ((($tests | ForEach-Object { $_.asx_order }) -join ',') -eq '1,2,3') "1: $($case[0]) tests must be ordered 1, 2, 3."
    $action = @($db.Actions | Where-Object { $_.asx_ruleactionid -eq $f[$case[0]] })[0]
    Assert ($null -eq $action.asx_fireon -and $action.asx_isactive) "1: $($case[0]) must have asx_fireon cleared and stay active."
}
Assert (@(RootsOf $f.A3).Count -eq 1 -and @(RootsOf $f.A3)[0].asx_actionconditiongroupid -eq $f.A3Root -and @(TestsOf $f.A3Root).Count -eq 1) '1: A3 keeps its existing tree.'
Assert (@($db.Log | Where-Object { $_ -match "^(POST|PATCH) asx_ruleactions\($($f.A3)\)" -or $_ -match "^GET asx_actionconditiongroups.*$($f.A3)" }).Count -eq 0) '1: A3 (no asx_fireon) is never touched.'
Assert (@(RootsOf $f.A4).Count -eq 1 -and @(RootsOf $f.A4)[0].asx_actionconditiongroupid -eq $f.A4Root -and @(TestsOf $f.A4Root).Count -eq 1) '1: A4 keeps its author-built tree.'
Assert ($null -eq (@($db.Actions | Where-Object { $_.asx_ruleactionid -eq $f.A4 })[0]).asx_fireon) '1: A4 has asx_fireon cleared.'
Assert ($f.R1 -notin $db.Publishes -and $f.R1 -notin $db.Opens -and !(DraftOf $f.R1)) '1: R1 is converted in place, with no draft and no publish.'
Assert (@(Writes | Where-Object { $_ -match "^PATCH asx_rules\($($f.R1)\)" }).Count -eq 0) '1: no publish request for R1.'

# 2. Published rule P1 without a draft: draft opened, converted, published.
$d1 = DraftOf $f.P1
Assert ($null -ne $d1 -and $f.P1 -in $db.Opens) '2: asx_OpenRuleDraft must open a draft for P1.'
Assert (@(Writes | Where-Object { $_ -eq 'POST asx_OpenRuleDraft' }).Count -eq 2) '2: drafts are opened only for P1 and U1.'
$d1Action = ActionNamed $d1.asx_ruleid 'Notify'
$d1Roots = @(RootsOf $d1Action.asx_ruleactionid)
Assert ($d1Roots.Count -eq 1 -and $d1Roots[0].asx_logicaloperator -eq 1 -and @(TestsOf $d1Roots[0].asx_actionconditiongroupid).Count -eq 1) "2: D1's action gets a root ALL with one test."
Assert (@(TestsOf $d1Roots[0].asx_actionconditiongroupid)[0]._asx_outcome_value -eq (GroupNamed $d1.asx_ruleid 'Valid').asx_conditiongroupid) "2: D1's test points at D1's own outcome."
Assert ($null -eq $d1Action.asx_fireon) "2: D1's action has asx_fireon cleared."
Assert ($null -ne (ActionNamed $f.P1 'Notify').asx_fireon) "2: P1's own rows are not written."
$publishIndex = $db.Log.IndexOf("PATCH asx_rules($($d1.asx_ruleid))")
Assert ($publishIndex -gt $db.Log.IndexOf("PATCH asx_ruleactions($($d1Action.asx_ruleactionid))")) '2: D1 is published (PATCH statuscode) after its rows are converted.'
Assert ($f.P1 -in $db.Publishes) '2: P1 is published.'

# 3. P2's draft is already converted: no writes, no publish.
$d2Rows = @(GroupsOf $f.D2 | ForEach-Object { $_.asx_conditiongroupid }) + @(ActionsOf $f.D2 | ForEach-Object { $_.asx_ruleactionid })
Assert (@(Writes | Where-Object { $w = $_; @($d2Rows + $f.D2 + $f.P2 | Where-Object { $w -match $_ }).Count -gt 0 }).Count -eq 0) '3: P2 / D2 get no writes.'
Assert ($f.P2 -notin $db.Publishes -and $f.P2 -notin $db.Opens) '3: P2 is not republished and no draft is opened.'

# 4. P3's draft has no outcomes.
$never = ActionNamed $f.D3 'Never fired'
Assert ($never.asx_isactive -eq $false -and $null -eq $never.asx_fireon -and @(RootsOf $never.asx_ruleactionid).Count -eq 0) '4: On no match with no outcomes is deactivated, asx_fireon cleared, no tree.'
$always = ActionNamed $f.D3 'Always set'
$alwaysRoots = @(RootsOf $always.asx_ruleactionid)
Assert ($alwaysRoots.Count -eq 1 -and $alwaysRoots[0].asx_logicaloperator -eq 1 -and @(TestsOf $alwaysRoots[0].asx_actionconditiongroupid).Count -eq 0) '4: On match with no outcomes gets an empty root ALL.'
Assert ($always.asx_isactive -and $null -eq $always.asx_fireon) '4: the Always action stays active with asx_fireon cleared.'
Assert ((Section $out 'Deactivated') -contains 'P3 no outcomes / Never fired') "4: 'P3 no outcomes / Never fired' must be listed under Deactivated.`n$out"
Assert ($f.P3 -in $db.Publishes) '4: P3 is published.'

# 5. P4's publish fails: listed with the Dataverse message; the run continues; exit code 1.
$failed = Section $out 'Failed'
Assert (@($failed | Where-Object { $_ -eq "Failed: $($f.P4) P4 publish fails: The rule has a lookup filter that points at a missing column." }).Count -eq 1) "5: P4 must be listed under Failed with the Dataverse message.`n$out"
Assert ($failed.Count -eq 1) "5: only P4 fails.`n$out"
Assert ($first.ExitCode -eq 1) "5: exit code must be 1 when a rule failed (was $($first.ExitCode))."
Assert ($null -eq (ActionNamed $f.D4 'Block').asx_fireon) "5: P4's draft was still converted."
Assert ($null -ne (DraftOf $f.U1) -and $null -eq (ActionNamed (DraftOf $f.U1).asx_ruleid 'Set flag').asx_fireon) '5: the run continues past P4 (U1, after it, is converted).'

# 6. U1 is published once but not enforcing: converted in its draft, not published.
$du = DraftOf $f.U1
Assert ($f.U1 -in $db.Opens -and @(RootsOf (ActionNamed $du.asx_ruleid 'Set flag').asx_ruleactionid).Count -eq 1) "6: U1's draft is opened and converted."
Assert ($f.U1 -notin $db.Publishes -and @(Writes | Where-Object { $_ -eq "PATCH asx_rules($($du.asx_ruleid))" }).Count -eq 0) '6: U1 is not published.'

# Summary lists.
$converted = Section $out 'Converted'
foreach ($name in @('R1 never published', 'P1 published no draft', 'P3 no outcomes', 'P4 publish fails', 'U1 unpublished')) {
    Assert (@($converted | Where-Object { $_ -like "$name (*" }).Count -eq 1) "Summary: '$name' must be listed under Converted.`n$out"
}
Assert ($converted.Count -eq 5) "Summary: exactly five rules converted.`n$out"
$publishedList = Section $out 'Published'
Assert ($publishedList.Count -eq 2 -and @($publishedList | Where-Object { $_ -like 'P1 published no draft (*' -or $_ -like 'P3 no outcomes (*' }).Count -eq 2) "Summary: P1 and P3 published.`n$out"
Assert ($out -notmatch 'mock-token') 'The token must never be printed.'
Assert ($out -notmatch 'https://') 'The environment URL must not be printed (host name only).'
Assert ($out -match 'migration\.invalid') 'The output names the environment host.'
Write-Host 'PASS: first run converts, names, deactivates, publishes enforcing rules and lists the failure (cases 1-6).'

# 7. Re-running against the post-run store writes nothing.
$db.Log.Clear()
$second = Run
Assert (@(Writes).Count -eq 0) "7: a re-run must make no write requests, saw:`n$(@(Writes) -join "`n")"
Assert ($second.ExitCode -eq 0) "7: a clean re-run exits 0.`n$($second.Output)"
Assert ((Section $second.Output 'Converted').Count -eq 0) "7: a re-run converts nothing.`n$($second.Output)"
Write-Host 'PASS: re-run is idempotent (case 7).'

# 8. -WhatIf against a fresh store: no POST or PATCH; P1-P4 and U1 listed by draft state.
$f = Seed
$dry = Run -WhatIf
Assert (@(Writes).Count -eq 0) "8: -WhatIf must send no POST or PATCH, saw:`n$(@(Writes) -join "`n")"
Assert ($dry.ExitCode -eq 0) "8: -WhatIf exits 0.`n$($dry.Output)"
$withDraft = Section $dry.Output 'Rules with a working draft'
$wouldOpen = Section $dry.Output 'Draft would be opened'
foreach ($name in @('P2 draft converted', 'P3 no outcomes', 'P4 publish fails')) {
    Assert (@($withDraft | Where-Object { $_ -like "$name (*" }).Count -eq 1) "8: '$name' must be listed under 'Rules with a working draft'.`n$($dry.Output)"
}
foreach ($name in @('P1 published no draft', 'U1 unpublished')) {
    Assert (@($wouldOpen | Where-Object { $_ -like "$name (*" }).Count -eq 1) "8: '$name' must be listed under 'Draft would be opened'.`n$($dry.Output)"
}
Assert (@($withDraft + $wouldOpen | Where-Object { $_ -like 'R1 *' }).Count -eq 0) '8: a never-published rule needs no draft.'
Assert ((Section $dry.Output 'Converted').Count -eq 5 -and (Section $dry.Output 'Deactivated') -contains 'P3 no outcomes / Never fired') "8: -WhatIf counts what would change.`n$($dry.Output)"
Assert ((Section $dry.Output 'Published').Count -eq 3) "8: -WhatIf counts P1, P3 and P4 as would-be publishes.`n$($dry.Output)"
Write-Host 'PASS: -WhatIf writes nothing and lists rules by draft state (case 8).'

# 9. An interrupted conversion (a test create fails) is completed by the next run, without duplicates.
$script:db = New-Store
$r = AddRule 'R2 interrupted'
$o1 = AddGroup $r.asx_ruleid 'First'; $o2 = AddGroup $r.asx_ruleid 'Second'
$a = AddAction $r.asx_ruleid 'Act' 2
# The second test create fails: the root and the first test exist, the second does not.
$db.FailTestCreateAt = 2
$broken = Run
Assert ($broken.ExitCode -eq 1 -and (Section $broken.Output 'Failed').Count -eq 1) "9: the interrupted rule is listed as failed.`n$($broken.Output)"
Assert ($a.asx_fireon -eq 2 -and @(RootsOf $a.asx_ruleactionid).Count -eq 1 -and @(TestsOf @(RootsOf $a.asx_ruleactionid)[0].asx_actionconditiongroupid).Count -eq 1) '9: after the interruption the action still has asx_fireon and a partial tree (root and one test).'
$healed = Run
$roots = @(RootsOf $a.asx_ruleactionid)
$tests = @(TestsOf $roots[0].asx_actionconditiongroupid)
Assert ($healed.ExitCode -eq 0 -and $roots.Count -eq 1 -and $roots[0].asx_logicaloperator -eq 2) "9: the re-run keeps the one root ANY.`n$($healed.Output)"
Assert ($tests.Count -eq 2 -and (($tests | ForEach-Object { $_._asx_outcome_value }) -join ',') -eq "$($o1.asx_conditiongroupid),$($o2.asx_conditiongroupid)" -and @($tests | Where-Object { $_.asx_expected }).Count -eq 0) '9: the re-run adds the missing "is false" test, in order, without duplicates.'
Assert ($null -eq $a.asx_fireon) '9: the re-run clears asx_fireon.'
Write-Host 'PASS: an interrupted conversion is completed by the re-run (case 9).'

Write-Host 'PASS: Convert-RulesToOutcomes offline tests.'
