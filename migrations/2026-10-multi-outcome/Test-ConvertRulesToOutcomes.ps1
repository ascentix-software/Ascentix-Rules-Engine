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
       # Rows of the other configuration tables (conditions, search criteria, node filters, messages), each with its Entity.
       Extra = [System.Collections.Generic.List[hashtable]]::new()
       # asx_rulerevision rows by id: the rule's frozen snapshot (Json) and createdon.
       Revisions = @{}
       Publishes = [System.Collections.Generic.List[string]]::new(); Opens = [System.Collections.Generic.List[string]]::new()
       FailPublish = @{}; SnapshotSource = @{}; FailTestCreateAt = 0; TestCreates = 0; Clock = 0
       ExpireTokenOn = $null; TokenExpired = $false; Rejected = 0
       # Before the upgrade: the Fires when tables do not exist, so every request to them answers 404.
       NoTreeTables = $false }
}
function NewId { [guid]::NewGuid().ToString() }
# The mock clock: one second per row written, as ISO 8601 UTC strings (Dataverse's format for createdon/modifiedon).
$mockEpoch = [datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
function Iso([datetime]$Value) { $Value.ToString('yyyy-MM-ddTHH:mm:ssZ', [cultureinfo]::InvariantCulture) }
function Stamp { $db.Clock++; Iso $mockEpoch.AddSeconds($db.Clock) }
function Plus([string]$Stamp, [int]$Seconds) {
    Iso ([datetime]::Parse($Stamp, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal')).AddSeconds($Seconds)
}
function AddRule([string]$Name, [int]$Status = 1, [bool]$Pointer = $false, [string]$DraftOf = $null) {
    $now = Stamp
    $rule = @{ asx_ruleid = (NewId); asx_name = $Name; statuscode = $Status; _asx_publishedrevision_value = $null; _asx_draftof_value = $DraftOf
        createdon = $now; modifiedon = $now }
    # A revision whose snapshot is taken by FreezeRevisions once the fixture's rows exist.
    if ($Pointer) { $rule._asx_publishedrevision_value = NewId; $db.Revisions[$rule._asx_publishedrevision_value] = @{ Json = $null; CreatedOn = $null } }
    $db.Rules.Add($rule); $rule
}
function AddGroup([string]$Rule, [string]$Name, $Execution = $false, [string]$Parent = $null) {
    $now = Stamp
    $group = @{ asx_conditiongroupid = (NewId); _asx_rule_value = $Rule; asx_name = $Name; asx_isexecutioncondition = $Execution
        _asx_parentconditiongroup_value = $Parent; createdon = $now; modifiedon = $now }
    $db.Groups.Add($group); $group
}
function AddAction([string]$Rule, [string]$Name, $FireOn) {
    $now = Stamp
    $action = @{ asx_ruleactionid = (NewId); _asx_rule_value = $Rule; asx_name = $Name; asx_fireon = $FireOn; asx_isactive = $true; createdon = $now; modifiedon = $now }
    $db.Actions.Add($action); $action
}
# An author-built tree: a root ANY with one "is true" test on the given outcome.
function AddTree([string]$Action, [string]$Outcome) {
    $now = Stamp
    $root = @{ asx_actionconditiongroupid = (NewId); _asx_ruleaction_value = $Action; _asx_parentgroup_value = $null; asx_logicaloperator = 2; asx_order = 1
        createdon = $now; modifiedon = $now }
    $db.Trees.Add($root)
    $db.Tests.Add(@{ asx_actionconditiontestid = (NewId); _asx_actionconditiongroup_value = $root.asx_actionconditiongroupid; _asx_outcome_value = $Outcome
        asx_expected = $true; asx_order = 1; createdon = $now; modifiedon = $now })
    $root
}
# The id the script gives one of its own tree rows (StableId in Convert-RulesToOutcomes.ps1, written out again here).
function ScriptId([string]$Key) {
    $hash = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes("asx-multi-outcome-2026-10/$Key".ToLowerInvariant()))
    [guid]::new([byte[]]$hash[0..15]).ToString()
}
# The tree an earlier run of the script built for an On match action with one outcome: a root ALL and an "is true"
# test, both with the script's stable ids. The caller clears the action's asx_fireon, as that run did.
function AddScriptTree([string]$Action, [string]$Outcome) {
    $now = Stamp
    $root = @{ asx_actionconditiongroupid = (ScriptId "$Action/root"); _asx_ruleaction_value = $Action; _asx_parentgroup_value = $null; asx_logicaloperator = 1
        asx_order = 1; createdon = $now; modifiedon = $now }
    $db.Trees.Add($root)
    $db.Tests.Add(@{ asx_actionconditiontestid = (ScriptId "$Action/test/$Outcome"); _asx_actionconditiongroup_value = $root.asx_actionconditiongroupid
        _asx_outcome_value = $Outcome; asx_expected = $true; asx_order = 1; createdon = $now; modifiedon = $now })
    $root
}
# A row of one of the other configuration tables, linked to its parent by the given lookup values.
function AddRow([string]$Entity, [hashtable]$Lookups) {
    $now = Stamp
    $row = @{ Entity = $Entity; "${Entity}id" = (NewId); createdon = $now; modifiedon = $now }
    foreach ($key in $Lookups.Keys) { $row[$key] = $Lookups[$key] }
    $db.Extra.Add($row); $row
}

# RuleSnapshot.Edges (Ascentix.RulesEngine.Core/Publication/RuleSnapshot.cs), written out independently of the script:
# parent table, child table, and the child's lookup as the Web API names it. The tableconfig -> tableconfig edge is
# left out: a rule's draft never owns the shared data model.
$mockEdges = @(
    @('asx_rule', 'asx_conditiongroup', '_asx_rule_value'), @('asx_rule', 'asx_ruleaction', '_asx_rule_value'),
    @('asx_conditiongroup', 'asx_rulecondition', '_asx_conditiongroup_value'),
    @('asx_conditiongroup', 'asx_nodefiltergroup', '_asx_conditiongroup_value'),
    @('asx_rulecondition', 'asx_searchcriteriagroup', '_asx_rulecondition_value'),
    @('asx_rulecondition', 'asx_nodefiltergroup', '_asx_rulecondition_value'),
    @('asx_searchcriteriagroup', 'asx_searchcriterion', '_asx_criteriagroup_value'),
    @('asx_searchcriteriagroup', 'asx_searchcriteriagroup', '_asx_parentcriteriagroup_value'),
    @('asx_nodefiltergroup', 'asx_nodefiltergroup', '_asx_parentfiltergroup_value'),
    @('asx_nodefiltergroup', 'asx_nodefiltercriterion', '_asx_filtergroup_value'),
    @('asx_nodefiltercriterion', 'asx_nodefiltergroup', '_asx_owningcriterion_value'),
    @('asx_ruleaction', 'asx_localizedmessage', '_asx_ruleaction_value'),
    @('asx_ruleaction', 'asx_nodefiltergroup', '_asx_ruleaction_value'),
    @('asx_ruleaction', 'asx_actionconditiongroup', '_asx_ruleaction_value'),
    @('asx_actionconditiongroup', 'asx_actionconditiontest', '_asx_actionconditiongroup_value'))
function TableRows([string]$Table) {
    switch ($Table) {
        'asx_rule' { @($db.Rules) } 'asx_conditiongroup' { @($db.Groups) } 'asx_ruleaction' { @($db.Actions) }
        'asx_actionconditiongroup' { @($db.Trees) } 'asx_actionconditiontest' { @($db.Tests) }
        default { @($db.Extra | Where-Object { $_.Entity -eq $Table }) }
    }
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

# A Web API error as Invoke-RestMethod raises it: the status is on the exception's response and the Dataverse
# body is in ErrorDetails.
function Fail([int]$Status, [string]$Message) {
    $response = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$Status)
    $record = [System.Management.Automation.ErrorRecord]::new(
        [Microsoft.PowerShell.Commands.HttpResponseException]::new("Response status code does not indicate success: $Status.", $response), 'WebCmdletWebResponseException',
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

# A published revision, as asx_ReadPublishedRule returns it: a RuleSnapshot serialized by DataContractJsonSerializer
# (Attributes is a list of Key/Value pairs; null attributes are absent), taken from the source rule's rows as they are
# now. As RuleDrafts.Reidentify does, only the rule header's id becomes the published rule's; every other row keeps
# its source id. A shared table configuration row is included, as RuleSnapshot.Capture includes the data model.
function SnapshotJson([string]$RuleId, [string]$Source) {
    $rows = [System.Collections.Generic.List[object]]::new()
    $rows.Add(@{ Entity = 'asx_rule'; Id = $RuleId; Attributes = @(@{ Key = 'asx_name'; Value = @{ Kind = 'string'; Value = (RuleById $RuleId).asx_name } }) })
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue(@('asx_rule', $Source))
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($edge in $mockEdges | Where-Object { $_[0] -eq $parent[0] }) {
            foreach ($row in TableRows $edge[1] | Where-Object { $_[$edge[2]] -eq $parent[1] }) {
                $id = $row["$($edge[1])id"]
                if (!$seen.Add("$($edge[1])/$id")) { continue }
                $queue.Enqueue(@($edge[1], $id))
                $attributes = @()
                if ($edge[1] -eq 'asx_ruleaction') {
                    $attributes = @(@{ Key = 'asx_rule'; Value = @{ Kind = 'reference'; Value = $RuleId; Entity = 'asx_rule' } },
                        @{ Key = 'asx_isactive'; Value = @{ Kind = 'bool'; Value = $(if ($row.asx_isactive) { 'True' } else { 'False' }) } })
                    if ($null -ne $row.asx_fireon) { $attributes += @{ Key = 'asx_fireon'; Value = @{ Kind = 'option'; Value = "$($row.asx_fireon)" } } }
                }
                elseif ($edge[1] -eq 'asx_actionconditiongroup') {
                    $attributes = @(@{ Key = 'asx_ruleaction'; Value = @{ Kind = 'reference'; Value = $row._asx_ruleaction_value; Entity = 'asx_ruleaction' } },
                        @{ Key = 'asx_logicaloperator'; Value = @{ Kind = 'option'; Value = "$($row.asx_logicaloperator)" } })
                }
                $rows.Add(@{ Entity = $edge[1]; Id = $id; Attributes = $attributes })
            }
        }
    }
    $rows.Add(@{ Entity = 'asx_tableconfig'; Id = (NewId); Attributes = @() })
    @{ Format = 1; RuleId = $RuleId; Rows = $rows.ToArray() } | ConvertTo-Json -Depth 10 -Compress
}
# Records a new revision of the rule taken from the source's rows and points the rule at it.
function PublishRevision([string]$RuleId, [string]$Source) {
    $id = NewId
    $db.Revisions[$id] = @{ Json = (SnapshotJson $RuleId $Source); CreatedOn = (Stamp) }
    (RuleById $RuleId)._asx_publishedrevision_value = $id
    $db.Revisions[$id]
}
# Takes the snapshot of every revision a fixture created with AddRule -Pointer, from the rule itself or the draft
# named in SnapshotSource.
function FreezeRevisions {
    foreach ($rule in @($db.Rules | Where-Object { $_._asx_publishedrevision_value })) {
        $revision = $db.Revisions[$rule._asx_publishedrevision_value]
        if ($revision.Json) { continue }
        $source = if ($db.SnapshotSource.ContainsKey($rule.asx_ruleid)) { $db.SnapshotSource[$rule.asx_ruleid] } else { $rule.asx_ruleid }
        $revision.Json = SnapshotJson $rule.asx_ruleid $source
        $revision.CreatedOn = Stamp
    }
}

# Copies a rule's rows into a new working draft with fresh ids, as asx_OpenRuleDraft does.
function OpenDraft([string]$RuleId) {
    $existing = DraftOf $RuleId
    if ($existing) { return $existing.asx_ruleid }
    $source = RuleById $RuleId
    $draft = AddRule $source.asx_name 1 $false $RuleId
    $map = @{}
    $now = $draft.createdon
    foreach ($g in GroupsOf $RuleId) { $map[$g.asx_conditiongroupid] = NewId }
    foreach ($g in GroupsOf $RuleId) {
        $copy = $g.Clone(); $copy.asx_conditiongroupid = $map[$g.asx_conditiongroupid]; $copy._asx_rule_value = $draft.asx_ruleid
        $copy.createdon = $now; $copy.modifiedon = $now
        if ($g._asx_parentconditiongroup_value) { $copy._asx_parentconditiongroup_value = $map[$g._asx_parentconditiongroup_value] }
        $db.Groups.Add($copy)
    }
    foreach ($a in ActionsOf $RuleId) {
        $copy = $a.Clone(); $copy.asx_ruleactionid = NewId; $copy._asx_rule_value = $draft.asx_ruleid; $copy.createdon = $now; $copy.modifiedon = $now; $db.Actions.Add($copy)
        foreach ($root in RootsOf $a.asx_ruleactionid) {
            $rootCopy = $root.Clone(); $rootCopy.asx_actionconditiongroupid = NewId; $rootCopy._asx_ruleaction_value = $copy.asx_ruleactionid
            $rootCopy.createdon = $now; $rootCopy.modifiedon = $now; $db.Trees.Add($rootCopy)
            foreach ($t in TestsOf $root.asx_actionconditiongroupid) {
                $testCopy = $t.Clone(); $testCopy.asx_actionconditiontestid = NewId; $testCopy.createdon = $now; $testCopy.modifiedon = $now
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
    # The token expires at the first request that matches ExpireTokenOn; every request after that is refused.
    if ($db.ExpireTokenOn -and $path -match $db.ExpireTokenOn) { $db.TokenExpired = $true }
    if ($db.TokenExpired) { $db.Rejected++; Fail 401 'The access token has expired.' }
    $record = if ($Body) { $Body | ConvertFrom-Json -AsHashtable } else { @{} }
    if ($db.NoTreeTables -and $path -match '^(asx_actionconditiongroups|asx_actionconditiontests)\b') {
        Fail 404 "Resource not found for the segment '$($Matches[1])'."
    }
    if ($Method -eq 'GET') {
        # The script asks once per run whether the Fires when tables exist.
        if ($path -match '^(asx_actionconditiongroup|asx_actionconditiontest)s\?\$select=(asx_[a-z]+)id&\$top=1$') {
            Assert ($Matches[1] -eq $Matches[2]) "The $($Matches[1]) probe must select its primary key."
            return Respond @{ value = @() }
        }
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
        # Draft-edit detection: the working draft header's modifiedon, the published revision's createdon, and the
        # draft's configuration rows, one table and one parent lookup at a time.
        if ($path -match "^asx_rules\(($mockGuid)\)\?\`$select=modifiedon$") {
            $rule = RuleById $Matches[1]
            Assert ($rule -and $rule._asx_draftof_value) 'Only a working draft header is read for its modifiedon.'
            return Respond @{ asx_ruleid = $rule.asx_ruleid; modifiedon = $rule.modifiedon }
        }
        if ($path -match "^asx_rulerevisions\(($mockGuid)\)\?\`$select=createdon$") {
            $revision = $db.Revisions[$Matches[1]]
            Assert ($revision -and $revision.CreatedOn) "Read of an unknown revision $($Matches[1])."
            return Respond @{ asx_rulerevisionid = $Matches[1]; createdon = $revision.CreatedOn }
        }
        if ($path -match "^(asx_[a-z]+)s\?\`$filter=\((.+)\)&\`$select=(asx_[a-z]+)id,modifiedon,createdon$") {
            $table = $Matches[1]; $clauses = $Matches[2] -split ' or '; $select = $Matches[3]
            Assert ($select -eq $table) "A $table query must select ${table}id (got ${select}id)."
            $ids = @(foreach ($clause in $clauses) {
                Assert ($clause -match "^(_asx_[a-z]+_value) eq ($mockGuid)$") "Unexpected filter clause on ${table}: $clause"
                $lookup = $Matches[1]; $Matches[2]
            })
            Assert (@($clauses | Where-Object { $_ -notmatch "^$([regex]::Escape($lookup)) eq " }).Count -eq 0) "One $table query filters on one lookup only."
            Assert (@($mockEdges | Where-Object { $_[1] -eq $table -and $_[2] -eq $lookup }).Count -eq 1) "$table is not a child of any rule table through ${lookup}."
            Assert ($ids.Count -le 50) "At most 50 parents per $table query (got $($ids.Count))."
            return Respond @{ value = @(TableRows $table | Where-Object { $_[$lookup] -and $ids -contains $_[$lookup] } |
                ForEach-Object { @{ "${table}id" = $_["${table}id"]; modifiedon = $_.modifiedon; createdon = $_.createdon } }) }
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
            # No revision pointer means no published revision to read (a Published rule from before revisions).
            if (!$rule._asx_publishedrevision_value) { Fail 400 'This rule has no published revision.' }
            $revision = $db.Revisions[$rule._asx_publishedrevision_value]
            Assert ($revision -and $revision.Json) "The fixture did not freeze the revision of '$($rule.asx_name)'."
            return Respond @{ Definition = $revision.Json }
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
            $now = Stamp
            $db.Trees.Add(@{ asx_actionconditiongroupid = $record.asx_actionconditiongroupid; _asx_ruleaction_value = $action.asx_ruleactionid
                _asx_parentgroup_value = $null; asx_logicaloperator = $record.asx_logicaloperator; asx_order = $record.asx_order; createdon = $now; modifiedon = $now })
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
            $now = Stamp
            $db.Tests.Add(@{ asx_actionconditiontestid = $record.asx_actionconditiontestid; _asx_actionconditiongroup_value = $group.asx_actionconditiongroupid
                _asx_outcome_value = $outcome.asx_conditiongroupid; asx_expected = $record.asx_expected; asx_order = $record.asx_order; createdon = $now; modifiedon = $now })
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
            # asx_conditiongroup.asx_name holds at most 100 characters (MaxLength in the shipped solution).
            if ($record.asx_name.Length -gt 100) { Fail 400 "A validation error occurred. The length of the 'asx_name' attribute of the 'asx_conditiongroup' entity exceeded the maximum allowed length of '100'." }
            AssertEditable $group._asx_rule_value
            $group.asx_name = $record.asx_name
            $group.modifiedon = Stamp
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
            $action.modifiedon = Stamp
            return
        }
        if ($path -match "^asx_rules\(($mockGuid)\)$") {
            $id = $Matches[1]
            $rule = RuleById $id
            Assert ($rule -and $rule._asx_draftof_value) 'Only a working draft is published.'
            Assert ((@($record.Keys) -join ',') -eq 'statuscode' -and $record.statuscode -eq $mockPublished) 'Publishing sets only statuscode 753840000.'
            if ($db.FailPublish.ContainsKey($id)) { Fail 400 $db.FailPublish[$id] }
            # The working copy stays a Draft (its header is updated); publishing records a revision taken from the
            # draft, keeping its row ids, and points the original rule at it.
            $db.Publishes.Add($rule._asx_draftof_value)
            $rule.modifiedon = Stamp
            PublishRevision $rule._asx_draftof_value $id | Out-Null
            return
        }
    }
    throw "Unexpected request: $Method $path"
}

function Run([switch]$WhatIf, [switch]$Loud, [switch]$PublishDraftEdits) {
    $global:LASTEXITCODE = 0
    $switches = @{ WhatIf = $WhatIf; Verbose = $Loud }
    # Passed only when set, so the existing cases also run against a script without the switch.
    if ($PublishDraftEdits) { $switches.PublishDraftEdits = $true }
    $output = & $MigrationScript -EnvUrl 'https://migration.invalid/' -AccessToken 'mock-token' @switches *>&1 | Out-String
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
    AddGroup $p3.asx_ruleid 'Run only when' $true | Out-Null
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
    AddScriptTree $d5Action.asx_ruleactionid $d5Outcome.asx_conditiongroupid | Out-Null
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
    FreezeRevisions
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

# The published revision is read only for enforcing rules that have one (P1-P5; P6 has no pointer).
Assert ((Reads) -eq 5) "Only the enforcing rules with a revision pointer (P1-P5) have their published revision read (saw $(Reads))."

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
Assert ($dry.Output -match 'Every rule ever published from the Rule Builder keeps a working draft' -and $dry.Output -match 'Publish or Discard') "8: -WhatIf explains the working-draft list and what to do before the real run.`n$($dry.Output)"
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

# 14. The token expires part-way: the run stops at the first 401 with one clear message instead of failing every
#     remaining rule, and a re-run with a new token finishes the work.
$tokenMessage = 'The access token expired or is invalid; get a new token and re-run (the script resumes safely)'
$script:db = New-Store
$t1 = AddRule 'T1 before expiry'; $t1o = AddGroup $t1.asx_ruleid 'Ok'; $t1a = AddAction $t1.asx_ruleid 'Act' 1
$t2 = AddRule 'T2 expires here'; AddGroup $t2.asx_ruleid 'Ok' | Out-Null; $t2a = AddAction $t2.asx_ruleid 'Act' 1
$t3 = AddRule 'T3 after expiry'; AddGroup $t3.asx_ruleid 'Ok' | Out-Null; $t3a = AddAction $t3.asx_ruleid 'Act' 2
$db.ExpireTokenOn = [regex]::Escape($t2.asx_ruleid)
$expired = Run
Assert ($expired.ExitCode -eq 1) "14: an expired token exits 1 (was $($expired.ExitCode)).`n$($expired.Output)"
Assert ($expired.Output.Contains($tokenMessage)) "14: the run names the expired token.`n$($expired.Output)"
Assert ($db.Rejected -eq 1) "14: the run stops at the first 401 (saw $($db.Rejected) refused requests)."
Assert ((Section $expired.Output 'Failed').Count -eq 0) "14: the remaining rules are not listed as failed.`n$($expired.Output)"
Assert ((Names $expired.Output 'Converted') -eq 'T1 before expiry' -and $null -eq $t1a.asx_fireon) "14: the rule before the expiry is converted.`n$($expired.Output)"
Assert ($null -ne $t2a.asx_fireon -and $null -ne $t3a.asx_fireon -and @($db.Log | Where-Object { $_ -match $t3.asx_ruleid }).Count -eq 0) '14: nothing is attempted after the 401.'
$db.ExpireTokenOn = $null; $db.TokenExpired = $false
$resumed = Run
Assert ($resumed.ExitCode -eq 0 -and (Names $resumed.Output 'Converted') -eq 'T2 expires here, T3 after expiry') "14: a re-run with a new token converts the rest.`n$($resumed.Output)"
Assert ($null -eq $t2a.asx_fireon -and $null -eq $t3a.asx_fireon -and @(RootsOf $t1a.asx_ruleactionid).Count -eq 1) '14: the re-run finishes the remaining rules without redoing the first.'
Write-Host 'PASS: an expired token stops the run with one message, and a re-run resumes (case 14).'

# 15. A de-duplicated outcome name that would pass the 100-character column keeps its suffix and shortens its base.
# 16. An action with an unknown asx_fireon value fails its rule; the run moves on to the next rule.
$script:db = New-Store
$long = 'Long outcome ' + ('n' * 87)  # exactly 100 characters
$l1 = AddRule 'L1 long names'
$l1First = AddGroup $l1.asx_ruleid $long; $l1Second = AddGroup $l1.asx_ruleid $long.ToUpperInvariant()
AddAction $l1.asx_ruleid 'Act' 1 | Out-Null
$m1 = AddRule 'M1 unknown fire on'; AddGroup $m1.asx_ruleid 'Ok' | Out-Null; $m1a = AddAction $m1.asx_ruleid 'Odd' 3
$n1 = AddRule 'N1 after'; AddGroup $n1.asx_ruleid 'Ok' | Out-Null; $n1a = AddAction $n1.asx_ruleid 'Act' 1
$edge = Run
$expectedName = $long.ToUpperInvariant().Substring(0, 96) + ' (2)'
Assert ($l1First.asx_name -ceq $long -and $l1Second.asx_name -ceq $expectedName -and $expectedName.Length -eq 100) "15: the duplicate becomes '$expectedName' (got '$($l1Second.asx_name)').`n$($edge.Output)"
Assert ((Section $edge.Output 'Failed') -contains "Failed: $($m1.asx_ruleid) M1 unknown fire on: Action 'Odd' has an unknown asx_fireon value 3.") "16: M1 is listed under Failed.`n$($edge.Output)"
Assert ((Section $edge.Output 'Failed').Count -eq 1 -and $edge.ExitCode -eq 1) "16: only M1 fails, and the run exits 1.`n$($edge.Output)"
Assert ($m1a.asx_fireon -eq 3 -and @(RootsOf $m1a.asx_ruleactionid).Count -eq 0) '16: the unknown action is left as it is.'
Assert ($null -eq $n1a.asx_fireon -and (Names $edge.Output 'Converted') -eq 'L1 long names, N1 after') "16: the run continues past M1.`n$($edge.Output)"
Write-Host 'PASS: long duplicate names fit the column, and an unknown fire-on value fails only its rule (cases 15-16).'

# ---------- draft-edit detection (cases a-k) ----------
$editsHeading = 'Drafts with edits since the last publish (skipped: publish or discard them, then re-run)'
# A rule's configuration with a row in every table the draft walk visits, each reached through a different edge
# (a node filter group through each of its five parents), plus an action that already has a Fires when tree.
function Graph([string]$Rule, [switch]$NoTree) {
    $g = @{}
    $g.Outcome = AddGroup $Rule 'Valid'
    $g.Condition = AddRow 'asx_rulecondition' @{ _asx_conditiongroup_value = $g.Outcome.asx_conditiongroupid }
    $search = AddRow 'asx_searchcriteriagroup' @{ _asx_rulecondition_value = $g.Condition.asx_ruleconditionid }
    $inner = AddRow 'asx_searchcriteriagroup' @{ _asx_parentcriteriagroup_value = $search.asx_searchcriteriagroupid }
    AddRow 'asx_searchcriterion' @{ _asx_criteriagroup_value = $inner.asx_searchcriteriagroupid } | Out-Null
    $filter = AddRow 'asx_nodefiltergroup' @{ _asx_conditiongroup_value = $g.Outcome.asx_conditiongroupid }
    AddRow 'asx_nodefiltergroup' @{ _asx_rulecondition_value = $g.Condition.asx_ruleconditionid } | Out-Null
    AddRow 'asx_nodefiltergroup' @{ _asx_parentfiltergroup_value = $filter.asx_nodefiltergroupid } | Out-Null
    $criterion = AddRow 'asx_nodefiltercriterion' @{ _asx_filtergroup_value = $filter.asx_nodefiltergroupid }
    AddRow 'asx_nodefiltergroup' @{ _asx_owningcriterion_value = $criterion.asx_nodefiltercriterionid } | Out-Null
    $g.Notify = AddAction $Rule 'Notify' 1
    $g.Message = AddRow 'asx_localizedmessage' @{ _asx_ruleaction_value = $g.Notify.asx_ruleactionid }
    AddRow 'asx_nodefiltergroup' @{ _asx_ruleaction_value = $g.Notify.asx_ruleactionid } | Out-Null
    # Before the upgrade no action has a tree.
    if (!$NoTree) {
        $g.Tag = AddAction $Rule 'Tag' $null
        AddTree $g.Tag.asx_ruleactionid $g.Outcome.asx_conditiongroupid | Out-Null
    }
    $g
}
# An enforcing rule last published from its working draft in the Rule Builder: the revision keeps the draft's row
# ids, and the publish updates the draft header in the same operation.
function SameIdRule([string]$Name, [scriptblock]$Before = $null, [switch]$NoTree) {
    $rule = AddRule $Name $mockPublished
    $draft = AddRule $Name 1 $false $rule.asx_ruleid
    $g = Graph $draft.asx_ruleid -NoTree:$NoTree
    if ($Before) { & $Before $draft $g }
    $revision = PublishRevision $rule.asx_ruleid $draft.asx_ruleid
    $draft.modifiedon = $revision.CreatedOn
    @{ Rule = $rule; Draft = $draft; G = $g; Published = $revision.CreatedOn }
}
# An enforcing rule published in place, whose working draft was opened a day later: asx_OpenRuleDraft (or Restore
# published to draft) creates every row at once with new ids.
function NewIdRule([string]$Name, [switch]$NoTree) {
    $rule = AddRule $Name $mockPublished
    Graph $rule.asx_ruleid -NoTree:$NoTree | Out-Null
    $revision = PublishRevision $rule.asx_ruleid $rule.asx_ruleid
    $db.Clock += 86400
    $draft = AddRule $Name 1 $false $rule.asx_ruleid
    $g = Graph $draft.asx_ruleid -NoTree:$NoTree
    @{ Rule = $rule; Draft = $draft; G = $g; Published = $revision.CreatedOn }
}
function EditFixtures {
    $script:db = New-Store
    $e = @{}
    # a: same ids, nothing changed (the header was updated 100 seconds after the revision: within the 2-minute margin).
    #    52 conditions, so their children are read in two batches (50 parents per query); only the last has a child.
    $e.A = SameIdRule 'Ea same ids unchanged' {
        param($draft, $g)
        $last = $null
        foreach ($n in 1..51) { $last = AddRow 'asx_rulecondition' @{ _asx_conditiongroup_value = $g.Outcome.asx_conditiongroupid } }
        AddRow 'asx_searchcriteriagroup' @{ _asx_rulecondition_value = $last.asx_ruleconditionid } | Out-Null
    }
    $e.A.Draft.modifiedon = Plus $e.A.Published 100
    # b: same ids, an action changed 10 minutes after the publish.
    $e.B = SameIdRule 'Eb action changed'; $e.B.G.Notify.modifiedon = Plus $e.B.Published 600
    # c: same ids, a condition added after the publish.
    $e.C = SameIdRule 'Ec condition added'
    $e.C.Extra = AddRow 'asx_rulecondition' @{ _asx_conditiongroup_value = $e.C.G.Outcome.asx_conditiongroupid }
    # d: same ids, a published message deleted from the draft.
    $e.D = SameIdRule 'Ed message deleted'; [void]$db.Extra.Remove($e.D.G.Message)
    # e: new ids, every row as the copy created it (one modified 3 seconds after its creation: within the margin).
    $e.E = NewIdRule 'Ee new ids unchanged'; $e.E.G.Message.modifiedon = Plus $e.E.G.Message.createdon 3
    # f: new ids, a condition changed a minute after the copy was made.
    $e.F = NewIdRule 'Ef new ids condition changed'; $e.F.G.Condition.modifiedon = Plus $e.F.G.Condition.createdon 60
    # c with new ids: a condition added later and never changed, so only the row count shows it.
    $e.G = NewIdRule 'Eg new ids condition added'
    $db.Clock += 600; AddRow 'asx_rulecondition' @{ _asx_conditiongroup_value = $e.G.G.Outcome.asx_conditiongroupid } | Out-Null
    # f with a replaced row: a message deleted and a new one added 10 minutes later, never changed. The counts match;
    #    only the late creation shows it.
    $e.H = NewIdRule 'Eh new ids message replaced'; [void]$db.Extra.Remove($e.H.G.Message)
    $db.Clock += 600; $e.H.Late = AddRow 'asx_localizedmessage' @{ _asx_ruleaction_value = $e.H.G.Notify.asx_ruleactionid }
    # i: the draft was converted by an earlier run (its stable-id Fires when roots) whose publish failed; the
    #    conversion changed it after the publish, but the script's own writes are not edits, so it is republished.
    $e.I = SameIdRule 'Ei converted, publish failed'
    $e.I.G.Notify.asx_fireon = $null; AddScriptTree $e.I.G.Notify.asx_ruleactionid $e.I.G.Outcome.asx_conditiongroupid | Out-Null
    $e.I.G.Notify.modifiedon = Plus $e.I.Published 3600
    # j: same ids, the draft header (name, table, triggers) changed 3 minutes after the publish.
    $e.J = SameIdRule 'Ej header changed'; $e.J.Draft.modifiedon = Plus $e.J.Published 180
    # New ids, the header changed 10 minutes after the copy's rows were created.
    $e.K = NewIdRule 'Ek new ids header changed'; $e.K.Draft.modifiedon = Plus (Iso $mockEpoch.AddSeconds($db.Clock)) 600
    # New ids, the header updated 3 seconds after the rows, as Restore published to draft does: unchanged.
    $e.L = NewIdRule 'El new ids restored'; $e.L.Draft.modifiedon = Plus (Iso $mockEpoch.AddSeconds($db.Clock)) 3
    # Same ids, the action deactivated in the draft after the publish: its only unconverted action is inactive, and
    #    the draft is still checked.
    $e.M = SameIdRule 'Em action deactivated'; $e.M.G.Notify.asx_isactive = $false; $e.M.G.Notify.modifiedon = Plus $e.M.Published 600
    # Published before revisions existed (Published status, no revision pointer), with a draft changed later: nothing
    #    to compare with, so it is listed for review and converted and published as before.
    $p = AddRule 'Ep published before revisions' $mockPublished
    Graph $p.asx_ruleid | Out-Null
    $db.Clock += 86400
    $pDraft = AddRule $p.asx_name 1 $false $p.asx_ruleid
    $pg = Graph $pDraft.asx_ruleid; $pg.Condition.modifiedon = Plus $pg.Condition.createdon 600
    $e.P = @{ Rule = $p; Draft = $pDraft; G = $pg }
    # The migration runs an hour after the last publish.
    $db.Clock += 3600
    $e
}
$editedNames = 'Eb action changed, Ec condition added, Ed message deleted, Ef new ids condition changed, Eg new ids condition added, Eh new ids message replaced, Ej header changed, Ek new ids header changed, Em action deactivated'
$notCheckedHeading = 'Drafts not checked (no published version to compare): review them by hand'
# The reason on the rule's "skipped" line.
function SkipReason([string]$Output, $Case) {
    $pattern = "(?m)^\s*$([regex]::Escape($Case.Rule.asx_name)) \($($Case.Rule.asx_ruleid)\): skipped \(its working draft has edits since the last publish: (.+)\)\r?$"
    if ($Output -match $pattern) { $Matches[1] } else { '(no skip line)' }
}
# Nothing was written to an edited rule or its draft.
function AssertUntouched($Case, [string]$Label) {
    $notify = $Case.G.Notify
    Assert ($notify.asx_fireon -eq 1 -and @(RootsOf $notify.asx_ruleactionid).Count -eq 0) "${Label}: the edited draft's action is not converted."
    Assert ($Case.Rule.asx_ruleid -notin $db.Publishes -and $Case.Rule.asx_ruleid -notin $db.Opens) "${Label}: the edited rule is not published and no draft is opened."
    $ids = @($Case.Rule.asx_ruleid, $Case.Draft.asx_ruleid, $notify.asx_ruleactionid, $Case.G.Outcome.asx_conditiongroupid)
    Assert (@(Writes | Where-Object { $w = $_; @($ids | Where-Object { $w -match $_ }).Count -gt 0 }).Count -eq 0) "${Label}: no write names the edited rule, its draft or their rows."
}

# a-f, i, j: one run over every kind of draft.
$e = EditFixtures
$edits = Run
$eo = $edits.Output
Assert ((Names $eo $editsHeading) -eq $editedNames) "b, c, d, f, j (and c and f variants): the edited drafts are listed under the new heading.`n$eo"
$reasons = [ordered]@{
    B = "row modified $(Plus $e.B.Published 600): asx_ruleaction"; C = 'row added: asx_rulecondition'; D = 'row removed: asx_localizedmessage'
    F = "row modified $(Plus $e.F.G.Condition.createdon 60): asx_rulecondition"; G = 'row counts differ: asx_rulecondition (draft 2, published 1)'
    H = "row added $($e.H.Late.createdon): asx_localizedmessage"; J = "header modified $(Plus $e.J.Published 180)"
    K = "header modified $($e.K.Draft.modifiedon)"; M = "row modified $(Plus $e.M.Published 600): asx_ruleaction" }
foreach ($key in $reasons.Keys) {
    $got = SkipReason $eo $e[$key]
    Assert ($got -eq $reasons[$key]) "The skip line of '$($e[$key].Rule.asx_name)' names the reason '$($reasons[$key])' (got '$got').`n$eo"
}
foreach ($case in @(@('B', 'b'), @('C', 'c'), @('D', 'd'), @('F', 'f'), @('G', 'c with new ids'), @('H', 'f with a replaced row'), @('J', 'j'),
        @('K', 'new ids, header changed'), @('M', 'inactive unconverted action'))) { AssertUntouched $e[$case[0]] $case[1] }
Assert ($edits.ExitCode -eq 0 -and (Section $eo 'Failed').Count -eq 0 -and (Section $eo 'Skipped (declined)').Count -eq 0) "b: a skipped draft is not a failure and does not change the exit code.`n$eo"
foreach ($case in @(@('A', 'a'), @('E', 'e'), @('L', 'new ids, header updated with the rows'), @('P', 'no published version'))) {
    $notify = $e[$case[0]].G.Notify
    Assert ($null -eq $notify.asx_fireon -and @(RootsOf $notify.asx_ruleactionid).Count -eq 1) "$($case[1]): the unchanged draft is converted."
}
Assert ((Names $eo 'Converted') -eq 'Ea same ids unchanged, Ee new ids unchanged, El new ids restored, Ep published before revisions') "a, e: the unchanged drafts are converted (the run continued past the skipped ones).`n$eo"
Assert ((Names $eo 'Published') -eq 'Ea same ids unchanged, Ee new ids unchanged, Ei converted, publish failed, El new ids restored, Ep published before revisions') "a, e, i: the unchanged and the already converted drafts are published.`n$eo"
Assert ((Names $eo $notCheckedHeading) -eq 'Ep published before revisions' -and $e.P.Rule.asx_ruleid -in $db.Publishes) "A draft with no published version to compare is listed for review, and still converted and published.`n$eo"
Assert ($eo -match 'their actions do not fire') "The advice says the skipped rules' actions do not fire until they are converted.`n$eo"
Assert ($e.I.Rule.asx_ruleid -in $db.Publishes) 'i: the already converted draft is republished.'
Assert (@($db.Log | Where-Object { $_ -match [regex]::Escape("asx_rules($($e.I.Draft.asx_ruleid))?`$select=modifiedon") }).Count -eq 0) 'i: a draft the script already converted is not compared.'
Assert ($eo -notmatch 'Every rule ever published from the Rule Builder keeps a working draft, so the next list includes all of them\. Each enforcing rule this run published went live from its draft, with any saved but unpublished changes in it') "The real run no longer says every published draft went live with its unpublished changes.`n$eo"
Write-Host 'PASS: drafts with edits since the last publish are listed and skipped; unchanged and converted drafts are published (cases a-f, i, j).'

# g: -PublishDraftEdits converts and publishes the drafts the previous run skipped.
$db.Log.Clear()
$forced = Run -PublishDraftEdits
Assert ($forced.ExitCode -eq 0 -and (Section $forced.Output $editsHeading).Count -eq 0) "g: -PublishDraftEdits lists no draft as skipped.`n$($forced.Output)"
Assert ((Names $forced.Output 'Published') -eq $editedNames -and (Names $forced.Output 'Converted') -eq $editedNames) "g: -PublishDraftEdits converts and publishes the edited drafts.`n$($forced.Output)"
Assert ($null -eq $e.B.G.Notify.asx_fireon -and @(RootsOf $e.B.G.Notify.asx_ruleactionid).Count -eq 1 -and $e.B.Rule.asx_ruleid -in $db.Publishes) 'g: case b is converted and published.'
Write-Host 'PASS: -PublishDraftEdits publishes drafts with edits (case g).'

# h: -WhatIf lists the edited drafts first in the summary and writes nothing.
$e = EditFixtures
$dryEdits = Run -WhatIf
$do = $dryEdits.Output
Assert (@(Writes).Count -eq 0) "h: -WhatIf must send no POST or PATCH, saw:`n$(@(Writes) -join "`n")"
$lines = $do -split "`r?`n"
$summaryAt = [array]::FindIndex($lines, [Predicate[string]]{ param($l) $l -match '^Summary' })
$firstHeading = @($lines | Select-Object -Skip ($summaryAt + 1) | Where-Object { $_ -match '^  \S.* \(\d+\):$' })[0]
Assert ($summaryAt -ge 0 -and $firstHeading -eq "  $editsHeading (9):") "h: the new heading is the first list of the -WhatIf summary (got '$firstHeading').`n$do"
Assert ((Names $do $editsHeading) -eq $editedNames) "h: -WhatIf lists the edited drafts, case b among them.`n$do"
Assert ((Names $do 'Converted') -eq 'Ea same ids unchanged, Ee new ids unchanged, El new ids restored, Ep published before revisions' -and $dryEdits.ExitCode -eq 0) "h: -WhatIf counts only the unchanged drafts as converted.`n$do"
Assert ((Names $do $notCheckedHeading) -eq 'Ep published before revisions') "h: -WhatIf lists the drafts it cannot check.`n$do"
Assert ($do -match '-PublishDraftEdits') "h: -WhatIf names -PublishDraftEdits.`n$do"
Write-Host 'PASS: -WhatIf lists drafts with edits first and writes nothing (case h).'

# k: a conversion the admin stopped half-way (here: declined one action under -Confirm) is not mistaken for an
#    edit on the re-run, although the script's own writes on the draft came after the publish.
$script:db = New-Store
$k = SameIdRule 'K stopped half-way' { param($draft, $g) $g.Alert = AddAction $draft.asx_ruleid 'Alert' 2 }
$db.Clock += 3600
& {
    function Approve-RuleMigrationWrite([string]$Target, [string]$Operation) { $Target -ne "action 'Alert' of rule 'K stopped half-way'" }
    $script:kFirst = Run
}
Assert ((Names $kFirst.Output 'Skipped (declined)') -eq 'K stopped half-way' -and $null -eq $k.G.Notify.asx_fireon -and $k.G.Alert.asx_fireon -eq 2) "k: the first run converts Notify and stops at Alert.`n$($kFirst.Output)"
$kSecond = Run
Assert ((Section $kSecond.Output $editsHeading).Count -eq 0) "k: the script's own earlier writes are not reported as draft edits.`n$($kSecond.Output)"
Assert ((Names $kSecond.Output 'Published') -eq 'K stopped half-way' -and $null -eq $k.G.Alert.asx_fireon -and $kSecond.ExitCode -eq 0) "k: the re-run finishes the conversion and publishes.`n$($kSecond.Output)"
Write-Host 'PASS: a half-finished conversion is resumed, not reported as an edit (case k).'

# Drafts with no action left to convert are still checked whenever the rule would be republished. The Rule Builder
# never clears On match / On no match, so a rule converted by hand and published keeps them in its published version.
$script:db = New-Store
# The author chose a Fires when for Notify in the Rule Builder and published (On match stays set).
$handConvert = { param($draft, $g) AddTree $g.Notify.asx_ruleactionid $g.Outcome.asx_conditiongroupid | Out-Null }
# l: then saved more draft edits.
$hl = SameIdRule 'Hl hand converted then edited' $handConvert; $hl.G.Condition.modifiedon = Plus $hl.Published 600
# m: and saved nothing since.
$hm = SameIdRule 'Hm hand converted unchanged' $handConvert
# n: a pre-upgrade draft that deleted every action (and the rows under them).
$hn = SameIdRule 'Hn every action deleted' -NoTree
[void]$db.Actions.Remove($hn.G.Notify)
foreach ($row in @($db.Extra | Where-Object { $_._asx_ruleaction_value -eq $hn.G.Notify.asx_ruleactionid })) { [void]$db.Extra.Remove($row) }
$hn.Draft.modifiedon = Plus $hn.Published 600
# o: a rule whose published version is already converted, with draft edits since: nothing to publish, so it is not
#    checked or listed.
$ho = SameIdRule 'Ho converted then edited' { param($draft, $g) $g.Notify.asx_fireon = $null; & $handConvert $draft $g }
$ho.G.Condition.modifiedon = Plus $ho.Published 600
$db.Clock += 3600
$hand = Run
$ho2 = $hand.Output
Assert ((Names $ho2 $editsHeading) -eq 'Hl hand converted then edited, Hn every action deleted') "l, n: drafts with nothing left to convert are still checked and listed when edited.`n$ho2"
Assert ((SkipReason $ho2 $hl) -eq "row modified $(Plus $hl.Published 600): asx_rulecondition") "l: the skip line names the edited condition.`n$ho2"
Assert ((SkipReason $ho2 $hn) -eq 'row removed: asx_ruleaction') "n: the skip line names the deleted action.`n$ho2"
Assert ($hl.Rule.asx_ruleid -notin $db.Publishes -and $hn.Rule.asx_ruleid -notin $db.Publishes) 'l, n: the edited drafts are not published.'
Assert ($hl.G.Notify.asx_fireon -eq 1) 'l: nothing is written to the edited draft.'
Assert ((Names $ho2 'Published') -eq 'Hm hand converted unchanged' -and $null -eq $hm.G.Notify.asx_fireon -and @(RootsOf $hm.G.Notify.asx_ruleactionid).Count -eq 1) "m: the unchanged hand-converted draft is converted (its tree kept) and republished.`n$ho2"
Assert ($ho.Rule.asx_ruleid -notin $db.Publishes -and $ho2 -match "(?m)^\s*Ho converted then edited \($($ho.Rule.asx_ruleid)\): no change\r?$") "o: a rule whose published version is converted is not checked, listed or published.`n$ho2"
Write-Host 'PASS: hand-converted and emptied drafts are checked before a republish (cases l, m, n, o).'

# Before the upgrade the Fires when tables do not exist. -WhatIf reads every action as having no tree and still
# checks the drafts; a real run stops at once with one message.
$script:db = New-Store
$db.NoTreeTables = $true
$na = SameIdRule 'Na unchanged' -NoTree
$nb = SameIdRule 'Nb action changed' -NoTree; $nb.G.Notify.modifiedon = Plus $nb.Published 600
$nc = NewIdRule 'Nc new ids unchanged' -NoTree
$db.Clock += 3600
$pre = Run -WhatIf
$po = $pre.Output
Assert ($pre.ExitCode -eq 0 -and (Section $po 'Failed').Count -eq 0 -and @(Writes).Count -eq 0) "Pre-upgrade -WhatIf: no failure and no writes.`n$po"
Assert ((Names $po $editsHeading) -eq 'Nb action changed') "Pre-upgrade -WhatIf: the edited draft is listed.`n$po"
Assert ((Names $po 'Converted') -eq 'Na unchanged, Nc new ids unchanged' -and (Names $po 'Published') -eq 'Na unchanged, Nc new ids unchanged') "Pre-upgrade -WhatIf: the unchanged drafts would be converted and published.`n$po"
Assert ($po -match 'The Fires when tables are not in this environment yet') "Pre-upgrade -WhatIf says why no trees were read.`n$po"
$db.Log.Clear()
$preReal = Run
Assert ($preReal.ExitCode -eq 1 -and $preReal.Output.Contains('Upgrade the solution first: the Fires when tables are missing.')) "A real run before the upgrade stops with one message.`n$($preReal.Output)"
Assert ($db.Log.Count -eq 1 -and (Section $preReal.Output 'Failed').Count -eq 0) "A real run before the upgrade sends nothing after the probe, saw:`n$($db.Log -join "`n")"
Write-Host 'PASS: before the upgrade, -WhatIf still checks drafts and a real run stops (missing Fires when tables).'

Write-Host 'PASS: Convert-RulesToOutcomes offline tests.'
# The last case runs the script into its own exit 1; a CI pwsh step exits with $LASTEXITCODE, so end clean.
exit 0
