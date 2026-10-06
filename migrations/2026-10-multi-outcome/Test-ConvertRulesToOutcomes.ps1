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
       FailPublish = @{}; SnapshotSource = @{}; FailTestCreateAt = 0; TestCreates = 0; Clock = 0 }
}
function NewId { [guid]::NewGuid().ToString() }
function Stamp { $db.Clock++; '2026-01-01T00:00:{0:00}Z' -f $db.Clock }
function AddRule([string]$Name, [int]$Status = 1, [bool]$Pointer = $false, [string]$DraftOf = $null) {
    $rule = @{ asx_ruleid = (NewId); asx_name = $Name; statuscode = $Status
        _asx_publishedrevision_value = $(if ($Pointer) { NewId } else { $null }); _asx_draftof_value = $DraftOf }
    $db.Rules.Add($rule); $rule
}
function AddGroup([string]$Rule, [string]$Name, $Execution = $false, [string]$Parent = $null) {
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
# asx_ReadPublishedRule is a POST but only reads.
function Writes { @($db.Log | Where-Object { $_ -notmatch '^GET ' -and $_ -ne 'POST asx_ReadPublishedRule' }) }

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
    # RuleDrafts.RequiresWorkingDraft: pointer set, Published, or it has a working draft.
    Assert ($header._asx_draftof_value -or (!$header._asx_publishedrevision_value -and $header.statuscode -ne $mockPublished -and !(DraftOf $Rule))) "Direct write to the rows of rule '$($header.asx_name)', which needs its working draft."
}

# The rule's active published revision, as asx_ReadPublishedRule returns it: a RuleSnapshot serialized by
# DataContractJsonSerializer (Attributes is a list of Key/Value pairs; null attributes are absent). The rows
# come from the rule itself until one of its drafts is published.
function SnapshotOf([string]$RuleId) {
    $source = if ($db.SnapshotSource.ContainsKey($RuleId)) { $db.SnapshotSource[$RuleId] } else { $RuleId }
    $rows = [System.Collections.Generic.List[object]]::new()
    $rows.Add(@{ Entity = 'asx_rule'; Id = $RuleId; Attributes = @(@{ Key = 'asx_name'; Value = @{ Kind = 'string'; Value = (RuleById $RuleId).asx_name } }) })
    foreach ($a in ActionsOf $source) {
        $attributes = @(@{ Key = 'asx_rule'; Value = @{ Kind = 'reference'; Value = $RuleId; Entity = 'asx_rule' } },
            @{ Key = 'asx_isactive'; Value = @{ Kind = 'bool'; Value = $(if ($a.asx_isactive) { 'True' } else { 'False' }) } })
        if ($null -ne $a.asx_fireon) { $attributes += @{ Key = 'asx_fireon'; Value = @{ Kind = 'option'; Value = "$($a.asx_fireon)" } } }
        $rows.Add(@{ Entity = 'asx_ruleaction'; Id = $a.asx_ruleactionid; Attributes = $attributes })
        foreach ($root in RootsOf $a.asx_ruleactionid) {
            $rows.Add(@{ Entity = 'asx_actionconditiongroup'; Id = $root.asx_actionconditiongroupid; Attributes = @(
                @{ Key = 'asx_ruleaction'; Value = @{ Kind = 'reference'; Value = $a.asx_ruleactionid; Entity = 'asx_ruleaction' } },
                @{ Key = 'asx_logicaloperator'; Value = @{ Kind = 'option'; Value = "$($root.asx_logicaloperator)" } }) })
        }
    }
    @{ Format = 1; RuleId = $RuleId; Rows = $rows.ToArray() } | ConvertTo-Json -Depth 10 -Compress
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
    [CmdletBinding()]
    param($Method, $Uri, $Headers, $ContentType, $Body)
    # -Verbose on the script must not make Invoke-RestMethod print full request URLs.
    Assert ($PSBoundParameters.ContainsKey('Verbose') -and !$PSBoundParameters['Verbose']) 'Invoke-RestMethod must be called with -Verbose:$false.'
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
        if ($path -match "^asx_conditiongroups\?\`$filter=_asx_rule_value eq ($mockGuid) and _asx_parentconditiongroup_value eq null and \(asx_isexecutioncondition eq false or asx_isexecutioncondition eq null\)&\`$select=asx_conditiongroupid,asx_name,createdon&\`$orderby=createdon asc$") {
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
        if ($path -eq 'asx_ReadPublishedRule') {
            Assert (@($record.Keys).Count -eq 1 -and $record.RuleId -match "^$mockGuid$") 'asx_ReadPublishedRule takes only RuleId.'
            $rule = RuleById $record.RuleId
            Assert ($rule -and !$rule._asx_draftof_value) 'asx_ReadPublishedRule is read for the rule, not its draft.'
            if (!$rule._asx_publishedrevision_value -and $rule.statuscode -ne $mockPublished) { Fail 400 'This rule has not been published.' }
            return Respond @{ Definition = (SnapshotOf $record.RuleId) }
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
            $db.SnapshotSource[$rule._asx_draftof_value] = $id
            return
        }
    }
    throw "Unexpected request: $Method $path"
}

function Run([switch]$WhatIf, [switch]$Loud) {
    $global:LASTEXITCODE = 0
    $output = & $MigrationScript -EnvUrl 'https://migration.invalid/' -AccessToken 'mock-token' -WhatIf:$WhatIf -Verbose:$Loud *>&1 | Out-String
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
# The rule names listed under a heading (each line is "<name> (<id>)"), sorted and comma-joined.
function Names([string]$Output, [string]$Heading) { @(Section $Output $Heading | ForEach-Object { $_ -replace ' \([0-9a-f-]{36}\)$', '' } | Sort-Object) -join ', ' }
function Reads { @($db.Log | Where-Object { $_ -eq 'POST asx_ReadPublishedRule' }).Count }
function GroupName([string]$Id) { (@($db.Groups | Where-Object { $_.asx_conditiongroupid -eq $Id })[0]).asx_name }

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
    # A null "Run only when" flag reads as false (the engine uses GetAttributeValue<bool>), so this is an outcome.
    $f.G4 = (AddGroup $r1.asx_ruleid '' $null).asx_conditiongroupid
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
    # 3. Published rule whose existing draft is converted and already published (its revision is the draft's).
    $p2 = AddRule 'P2 draft converted' $mockPublished $true
    $f.P2 = $p2.asx_ruleid
    $d2 = AddRule $p2.asx_name 1 $false $p2.asx_ruleid
    $f.D2 = $d2.asx_ruleid
    $d2Outcome = AddGroup $d2.asx_ruleid 'Done'
    $d2Action = AddAction $d2.asx_ruleid 'Notify' $null
    AddTree $d2Action.asx_ruleactionid $d2Outcome.asx_conditiongroupid | Out-Null
    $db.SnapshotSource[$p2.asx_ruleid] = $d2.asx_ruleid
    # 4. Published rule whose draft has no outcomes.
    $p3 = AddRule 'P3 no outcomes' $mockPublished $true
    $f.P3 = $p3.asx_ruleid
    # Its published revision: the pre-upgrade rows, which the draft below copies.
    AddAction $p3.asx_ruleid 'Always set' 1 | Out-Null
    AddAction $p3.asx_ruleid 'Never fired' 2 | Out-Null
    $d3 = AddRule $p3.asx_name 1 $false $p3.asx_ruleid
    $f.D3 = $d3.asx_ruleid
    AddGroup $d3.asx_ruleid 'Run only when' $true | Out-Null
    AddAction $d3.asx_ruleid 'Always set' 1 | Out-Null
    AddAction $d3.asx_ruleid 'Never fired' 2 | Out-Null
    # 5. Published rule whose publish fails.
    $p4 = AddRule 'P4 publish fails' $mockPublished $true
    $f.P4 = $p4.asx_ruleid
    AddGroup $p4.asx_ruleid 'Amount' | Out-Null
    AddAction $p4.asx_ruleid 'Block' 2 | Out-Null
    $d4 = AddRule $p4.asx_name 1 $false $p4.asx_ruleid
    $f.D4 = $d4.asx_ruleid
    AddGroup $d4.asx_ruleid 'Amount' | Out-Null
    AddAction $d4.asx_ruleid 'Block' 2 | Out-Null
    $db.FailPublish[$d4.asx_ruleid] = 'The rule has a lookup filter that points at a missing column.'
    # 10. Enforcing rule whose draft was converted but never published (an earlier run was killed before the
    #     publish): its published revision still uses On match.
    $p5 = AddRule 'P5 converted never published' $mockPublished $true
    $f.P5 = $p5.asx_ruleid
    AddGroup $p5.asx_ruleid 'Ok' | Out-Null
    AddAction $p5.asx_ruleid 'Notify' 1 | Out-Null
    $d5 = AddRule $p5.asx_name 1 $false $p5.asx_ruleid
    $f.D5 = $d5.asx_ruleid
    $d5Outcome = AddGroup $d5.asx_ruleid 'Ok'
    $d5Action = AddAction $d5.asx_ruleid 'Notify' $null
    AddTree $d5Action.asx_ruleactionid $d5Outcome.asx_conditiongroupid | Out-Null
    # 11. Published status with no revision pointer (published before revisions existed), no draft.
    $p6 = AddRule 'P6 published no pointer' $mockPublished $false
    $f.P6 = $p6.asx_ruleid
    AddGroup $p6.asx_ruleid 'Valid' | Out-Null
    AddAction $p6.asx_ruleid 'Notify' 2 | Out-Null
    # 12. Not published and no pointer, but it has a working draft: edited through the draft, not published.
    $q1 = AddRule 'Q1 draft only'
    $f.Q1 = $q1.asx_ruleid
    AddGroup $q1.asx_ruleid 'Ok' | Out-Null
    AddAction $q1.asx_ruleid 'Set' 1 | Out-Null
    $dq = AddRule $q1.asx_name 1 $false $q1.asx_ruleid
    $f.DQ = $dq.asx_ruleid
    AddGroup $dq.asx_ruleid 'Ok' | Out-Null
    AddAction $dq.asx_ruleid 'Set' 1 | Out-Null
    # 6. Published once, currently unpublished (pointer set, Draft status), no draft. Sorted after P4.
    $u1 = AddRule 'U1 unpublished' 1 $true
    $f.U1 = $u1.asx_ruleid
    AddGroup $u1.asx_ruleid 'Has phone' | Out-Null
    AddAction $u1.asx_ruleid 'Set flag' 1 | Out-Null
    $f
}

# ---------- RED check ----------
Assert (Test-Path $MigrationScript) "Migration script not found: $MigrationScript"

# ---------- first run (with -Verbose, which must not leak request URLs) ----------
$f = Seed
$first = Run -Loud
$out = $first.Output

# 1. Never-published rule R1 converts in place.
Assert ((GroupName $f.G1) -eq 'Outcome 1') '1: blank outcome G1 must be named "Outcome 1".'
Assert ((GroupName $f.G2) -ceq 'Big') '1: G2 "Big" keeps its name.'
Assert ((GroupName $f.G3) -ceq 'big (2)') '1: duplicate G3 "big" must become "big (2)".'
Assert ((GroupName $f.G4) -eq 'Outcome 2') '1: blank outcome G4 (null "Run only when" flag) must be named "Outcome 2".'
Assert ((GroupName $f.Exec) -eq '') '1: an execution-condition group is not an outcome and is not renamed.'
Assert ((GroupName $f.Nested) -eq '') '1: a nested group is not an outcome and is not renamed.'
foreach ($case in @(@('A1', 1, $true), @('A2', 2, $false))) {
    $roots = @(RootsOf $f[$case[0]])
    Assert ($roots.Count -eq 1 -and $roots[0].asx_logicaloperator -eq $case[1] -and $roots[0].asx_order -eq 1) "1: $($case[0]) must get one root with operator $($case[1])."
    $tests = @(TestsOf $roots[0].asx_actionconditiongroupid)
    Assert ((($tests | ForEach-Object { $_._asx_outcome_value }) -join ',') -eq (@($f.G1, $f.G2, $f.G3, $f.G4) -join ',')) "1: $($case[0]) must test G1, G2, G3, G4 in order."
    Assert (@($tests | Where-Object { $_.asx_expected -ne $case[2] }).Count -eq 0) "1: $($case[0]) tests must all expect $($case[2])."
    Assert ((($tests | ForEach-Object { $_.asx_order }) -join ',') -eq '1,2,3,4') "1: $($case[0]) tests must be ordered 1, 2, 3, 4."
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
Assert ((@($db.Opens | ForEach-Object { (RuleById $_).asx_name } | Sort-Object) -join ', ') -eq 'P1 published no draft, P6 published no pointer, U1 unpublished') '2: drafts are opened only for P1, P6 and U1.'
$d1Action = ActionNamed $d1.asx_ruleid 'Notify'
$d1Roots = @(RootsOf $d1Action.asx_ruleactionid)
Assert ($d1Roots.Count -eq 1 -and $d1Roots[0].asx_logicaloperator -eq 1 -and @(TestsOf $d1Roots[0].asx_actionconditiongroupid).Count -eq 1) "2: D1's action gets a root ALL with one test."
Assert (@(TestsOf $d1Roots[0].asx_actionconditiongroupid)[0]._asx_outcome_value -eq (GroupNamed $d1.asx_ruleid 'Valid').asx_conditiongroupid) "2: D1's test points at D1's own outcome."
Assert ($null -eq $d1Action.asx_fireon) "2: D1's action has asx_fireon cleared."
Assert ($null -ne (ActionNamed $f.P1 'Notify').asx_fireon) "2: P1's own rows are not written."
$publishIndex = $db.Log.IndexOf("PATCH asx_rules($($d1.asx_ruleid))")
Assert ($publishIndex -gt $db.Log.IndexOf("PATCH asx_ruleactions($($d1Action.asx_ruleactionid))")) '2: D1 is published (PATCH statuscode) after its rows are converted.'
Assert ($f.P1 -in $db.Publishes) '2: P1 is published.'

# 3. P2's draft is converted and its revision already published: no writes, no publish.
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

# 10. P5's draft is converted but was never published: no conversion writes, but it is republished.
$d5Action = (ActionNamed $f.D5 'Notify').asx_ruleactionid
Assert ((@(Writes | Where-Object { $_ -match $f.D5 -or $_ -match $d5Action }) -join '|') -eq "PATCH asx_rules($($f.D5))") '10: the only write for P5 is the publish of its draft.'
Assert ($f.P5 -in $db.Publishes) '10: P5, whose published revision still uses On match, is republished.'

# 11. P6 (Published, no pointer) is treated as published: drafted, converted, republished; its own rows untouched.
$d6 = DraftOf $f.P6
Assert ($null -ne $d6 -and @(RootsOf (ActionNamed $d6.asx_ruleid 'Notify').asx_ruleactionid)[0].asx_logicaloperator -eq 2) '11: P6 is converted in a new draft (root ANY).'
Assert ($null -ne (ActionNamed $f.P6 'Notify').asx_fireon -and $f.P6 -in $db.Publishes) "11: P6's own rows are untouched and P6 is republished."

# 12. Q1 (has a draft, no pointer, not Published) is converted in its draft only, and not published.
Assert ($null -eq (ActionNamed $f.DQ 'Set').asx_fireon -and @(RootsOf (ActionNamed $f.DQ 'Set').asx_ruleactionid).Count -eq 1) "12: Q1's draft is converted."
Assert ($null -ne (ActionNamed $f.Q1 'Set').asx_fireon -and $f.Q1 -notin $db.Opens -and $f.Q1 -notin $db.Publishes) "12: Q1's own rows are untouched, no draft is opened, and Q1 is not published."
Assert (@(Writes | Where-Object { $_ -eq "PATCH asx_rules($($f.DQ))" }).Count -eq 0) '12: no publish request for Q1.'

# The published revision is read only for the enforcing rules (P1-P6).
Assert ((Reads) -eq 6) "Only the six enforcing rules have their published revision read (saw $(Reads))."

# Summary lists.
Assert ((Names $out 'Converted') -eq 'P1 published no draft, P3 no outcomes, P4 publish fails, P6 published no pointer, Q1 draft only, R1 never published, U1 unpublished') "Summary: Converted list.`n$out"
Assert ((Names $out 'Published') -eq 'P1 published no draft, P3 no outcomes, P5 converted never published, P6 published no pointer') "Summary: Published list.`n$out"
Assert ((Names $out 'Rules with a working draft') -eq 'P2 draft converted, P3 no outcomes, P4 publish fails, P5 converted never published, Q1 draft only') "Summary: working-draft list.`n$out"
Assert ($out -notmatch 'mock-token') 'The token must never be printed.'
Assert ($out -notmatch 'https://') 'The environment URL must not be printed (host name only), even with -Verbose.'
Assert ($out -match 'migration\.invalid') 'The output names the environment host.'
Write-Host 'PASS: first run converts, names, deactivates, publishes enforcing rules and lists the failure (cases 1-6, 10-12).'

# 7. Re-run after fixing P4's problem: the only write is P4's publish (its published revision is still unconverted).
$db.FailPublish.Clear()
$db.Log.Clear()
$second = Run
Assert ((@(Writes) -join '|') -eq "PATCH asx_rules($($f.D4))") "7: the re-run's only write is P4's publish, saw:`n$(@(Writes) -join "`n")"
Assert ($second.ExitCode -eq 0 -and (Names $second.Output 'Published') -eq 'P4 publish fails' -and (Section $second.Output 'Converted').Count -eq 0) "7: the re-run publishes P4 and converts nothing.`n$($second.Output)"
# Once everything is published, a further run writes nothing.
$db.Log.Clear()
$third = Run
Assert (@(Writes).Count -eq 0) "7: a run on a converted environment must make no write requests, saw:`n$(@(Writes) -join "`n")"
Assert ($third.ExitCode -eq 0 -and (Section $third.Output 'Published').Count -eq 0 -and (Section $third.Output 'Converted').Count -eq 0) "7: nothing to convert or publish.`n$($third.Output)"
Write-Host 'PASS: re-run recovers the failed publish, then is idempotent (case 7).'

# 8. -WhatIf against a fresh store: no POST or PATCH (reads only); rules listed by draft state.
$f = Seed
$dry = Run -WhatIf
Assert (@(Writes).Count -eq 0) "8: -WhatIf must send no POST or PATCH, saw:`n$(@(Writes) -join "`n")"
Assert ($dry.ExitCode -eq 0) "8: -WhatIf exits 0.`n$($dry.Output)"
Assert ((Names $dry.Output 'Rules with a working draft') -eq 'P2 draft converted, P3 no outcomes, P4 publish fails, P5 converted never published, Q1 draft only') "8: working-draft list.`n$($dry.Output)"
Assert ((Names $dry.Output 'Draft would be opened') -eq 'P1 published no draft, P6 published no pointer, U1 unpublished') "8: would-open list.`n$($dry.Output)"
Assert ((Section $dry.Output 'Converted').Count -eq 7 -and (Section $dry.Output 'Deactivated') -contains 'P3 no outcomes / Never fired') "8: -WhatIf counts what would change.`n$($dry.Output)"
Assert ((Names $dry.Output 'Published') -eq 'P1 published no draft, P3 no outcomes, P4 publish fails, P5 converted never published, P6 published no pointer') "8: -WhatIf counts would-be publishes.`n$($dry.Output)"
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

# 13. -Confirm: decline opening P1's draft and deactivating P3's action. The script asks
#     Approve-RuleMigrationWrite, when the caller defines one, in place of the -Confirm prompt.
$f = Seed
& {
    function Approve-RuleMigrationWrite([string]$Target, [string]$Operation) {
        !(($Target -eq "rule 'P1 published no draft'" -and $Operation -eq 'Open a working draft') -or
          $Target -eq "action 'Never fired' of rule 'P3 no outcomes'")
    }
    $script:confirmed = Run
}
$co = $confirmed.Output
Assert ((Names $co 'Skipped (declined)') -eq 'P1 published no draft, P3 no outcomes') "13: P1 and P3 are listed under 'Skipped (declined)'.`n$co"
Assert ($f.P1 -notin $db.Opens -and !(DraftOf $f.P1) -and (Names $co 'Drafts opened') -notmatch 'P1') "13: a declined draft open opens nothing and is not listed as opened.`n$co"
$never = ActionNamed $f.D3 'Never fired'
Assert ($never.asx_isactive -and $never.asx_fireon -eq 2) '13: the declined deactivation did not happen.'
Assert ((Section $co 'Deactivated').Count -eq 0) "13: a declined deactivation is not listed under Deactivated.`n$co"
Assert ($f.P3 -notin $db.Publishes -and @(Writes | Where-Object { $_ -eq "PATCH asx_rules($($f.D3))" }).Count -eq 0) '13: a rule with a declined write is not published.'
Assert ((Names $co 'Published') -eq 'P5 converted never published, P6 published no pointer') "13: the other enforcing rules still publish (P4 fails as before).`n$co"
Write-Host 'PASS: declined -Confirm writes are not reported as done and block the publish (case 13).'

Write-Host 'PASS: Convert-RulesToOutcomes offline tests.'
