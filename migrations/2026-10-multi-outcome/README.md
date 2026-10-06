# Convert rules to outcome logic (one-time, October 2026)

`Convert-RulesToOutcomes.ps1` converts every existing rule from the retired **On match / On no match**
setting on each action (`asx_ruleaction.asx_fireon`) to the new **Fires when** logic, then republishes the
rules that are currently enforcing. The upgraded engine ignores On match / On no match: until this script
runs, actions on rules published before the upgrade do not fire (nothing is blocked wrongly, but nothing
fires either). Run it straight after the upgrade.

The script uses only the public Web API: row writes on working drafts, `asx_OpenRuleDraft`, and publishing
by setting a draft's status. It does not touch the engine or the Rule Builder.

## What it does

For every rule (working drafts are handled together with their rule):

1. **Where it edits.** A rule that has a published revision, has the status Published, or already has a
   working draft is edited through its working draft; the script opens one with `asx_OpenRuleDraft` if the
   rule has none. Any other rule (never published) is edited directly.
2. **Names the outcomes.** Each outcome (a top-level validation group, not a "Run only when" group; a group
   whose "Run only when" flag is empty counts as an outcome, as it does in the engine) needs a
   unique name. A blank name becomes "Outcome N" (the smallest N not already used); a repeated name,
   ignoring case, gets " (2)", " (3)" and so on, with the name shortened if needed to fit the
   100-character name column.
3. **Builds each action's Fires when tree.** For each action that still has On match / On no match set and
   no tree:
   - **On match** becomes a root **ALL** group with one test "*outcome* is true" per outcome. A rule with
     no outcomes gets an empty ALL group, which means "always, when the rule runs".
   - **On no match** becomes a root **ANY** group with one test "*outcome* is false" per outcome. With no
     outcomes the action could never fire, so it is **deactivated** and listed.
   - On match / On no match is then cleared. An action that already has a tree keeps it.
4. **Republishes.** For a rule that is currently enforcing (status Published), the script reads its
   published version (`asx_ReadPublishedRule`). While that version still has an active action with On
   match / On no match set, or an active action with no Fires when tree, the converted draft is published;
   the normal publish checks run. A rule whose published version is already converted is not republished.
   A Published rule from before published revisions existed has no published version to read, so it is
   always republished; that gives it one, and later runs read it like any other.
   A rule that was published before but is not enforcing now is converted in its draft and left
   unpublished. A rule whose publish fails is listed with the Dataverse message and the script moves on to
   the next rule.

## Draft-edit detection

Republishing an enforcing rule publishes everything in its working draft, including changes someone saved
but never published. So before the script writes anything to an enforcing rule that already has a working
draft with actions still to convert (On match / On no match set, no Fires when tree), it checks whether that
draft was changed since the rule was last published:

- It reads the published version (`asx_ReadPublishedRule`) and when it was published (the revision's
  `createdon`), and reads the draft's configuration rows table by table: outcomes and their conditions,
  search criteria, node filters, actions, messages and Fires when trees. Shared table configurations (the data
  model) are not part of a draft and are not compared.
- **A draft last published from the Rule Builder** keeps the published version's row ids. It counts as
  changed when a published row is missing from it, it has a row the published version doesn't, or any of its
  rows (the rule's own settings included) was modified more than 2 minutes after the publish.
- **A draft with all-new row ids** (opened after the rule was published without a draft, or reset with
  Discard) counts as unchanged only when each table has as many rows as the published version, no row was
  modified more than a few seconds after it was created, all its rows were created together (within 2
  minutes of each other, by the one operation that made the copy), and the rule's own settings were not
  modified more than 2 minutes after the last row was created (Discard updates them right after the rows).

A changed draft is listed under **Drafts with edits since the last publish (skipped: publish or discard
them, then re-run)** and its rule is skipped: nothing is written to it and it is not published. The rule's
line names the first difference found, for example `row added: asx_rulecondition`, `row removed:
asx_localizedmessage`, `row modified 2026-10-06T09:12:00Z: asx_ruleaction`, `header modified ...` (the
rule's own settings) or `row counts differ: ...`. This is not a failure and does not change the exit code.
**Until a skipped rule is converted and published, its actions do not fire after the upgrade**: the
upgraded engine ignores On match / On no match. So deal with the list straight away. For each listed rule,
open it in the Rule Builder and either:

- **Discard** the draft changes (the draft goes back to the published version), or
- **Publish** them. After the upgrade, the Rule Builder only publishes a rule whose actions each have a
  Fires when condition, so choose one for each action first; the script then has nothing left to convert in
  that rule.

Then run the script again. Or, once you have checked the listed drafts and want their changes to go live,
run it again with `-PublishDraftEdits`: drafts are then not checked, and each listed rule is converted and
published with its changes.

Drafts that are not checked:

- A draft with no actions left to convert (converted by an earlier run, or in the Rule Builder): the
  republish decision above applies as usual, so a run that converted a draft but failed to publish it is
  still finished by the next run.
- A draft holding a Fires when condition this script created (a run that was stopped part-way, or where you
  declined a write under `-Confirm`): that run checked it before writing, and the script's own changes are
  not draft edits.
- An enforcing rule published before published versions were kept (status Published, no published
  version): there is nothing to compare its draft with. It is converted and published from its draft as
  before, with any saved but unpublished changes in it, and listed under **Drafts not checked (no published
  version to compare): review them by hand**. Open each and check that what is live is what you want.
- Rules without a working draft (the script opens one, which has no edits), rules that are not enforcing (they
  are not published), and rules that were never published.

One case is flagged although nothing was edited by hand: a rule with no outcomes whose On no match actions
the script was deactivating when a run stopped part-way. Its next run lists it as edited (the deactivation
it already made counts as a change); run again with `-PublishDraftEdits` to finish it.

Before the upgrade the Fires when tables do not exist yet. A `-WhatIf` run then reads every action as having
no Fires when condition and still checks the drafts (it says so at the start); a real run stops at once with
"Upgrade the solution first: the Fires when tables are missing." and exit code 1.

## Before you upgrade

Every rule that has ever been published from the Rule Builder keeps a working draft, so the script's
"Rules with a working draft" list includes all of them. The script republishes enforcing rules from their
drafts, but it checks each draft first and lists, under **Drafts with edits since the last publish**, only
the drafts changed since their last publish (see *Draft-edit detection*); it skips those rules.

Run the script with `-WhatIf` first (it can run before or after the upgrade; it writes nothing): the drafts
with edits are the first list of its summary. Before you upgrade, open each of those rules and **Publish** or
**Discard** its changes; that is simplest before the upgrade, while the Rule Builder still publishes
On match / On no match actions.

## Running it

PowerShell 7.2 or later. Sign in as a **System Administrator** or **System Customizer** of the environment,
then:

```powershell
$url = 'https://<your-org>.crm.dynamics.com'
$token = az account get-access-token --resource $url --query accessToken -o tsv

# 1. Report only: lists what would change, writes nothing.
./Convert-RulesToOutcomes.ps1 -EnvUrl $url -AccessToken $token -WhatIf

# 2. Convert and republish.
./Convert-RulesToOutcomes.ps1 -EnvUrl $url -AccessToken $token
```

Any Dataverse bearer token for such a user works in place of `az`. The script never prints the token, and
prints only the host name of the environment, also with `-Verbose`. A token lasts about an hour: if
Dataverse refuses it during a run (HTTP 401), the script stops at that point with "The access token
expired or is invalid; get a new token and re-run (the script resumes safely)." Get a new token and run
the script again (see below).

To convert and publish drafts listed under **Drafts with edits since the last publish** with their changes,
once you have checked them:

```powershell
./Convert-RulesToOutcomes.ps1 -EnvUrl $url -AccessToken $token -PublishDraftEdits
```

Add `-Confirm` to approve each write one at a time. If you decline any write for a rule (including opening
its working draft), that rule is not published, nothing you declined is reported as done, and the rule is
listed under **Skipped (declined)**. Its draft may be partly converted; run the script again (without
declining) to finish it.

## Output

Each rule gets one line (`converted`, `published`, `no change`, `skipped (declined)`,
`skipped (its working draft has edits since the last publish: <first difference>)` or
`FAILED: <message>`), followed by a summary:

- **Drafts with edits since the last publish (skipped: publish or discard them, then re-run)**, listed
  first: enforcing rules whose working draft changed since their last publish; nothing was written to them
  (see *Draft-edit detection*). Their actions do not fire until they are converted and published. Not shown
  with `-PublishDraftEdits`.
- **Drafts not checked (no published version to compare): review them by hand**: enforcing rules published
  before published versions were kept; converted and published from their drafts as they are. Not shown with
  `-PublishDraftEdits`.
- **Converted**: rules whose outcomes or actions changed.
- **Published**: enforcing rules that were republished (their published version was not yet converted).
- **Deactivated**: `<rule> / <action>` for each On no match action on a rule with no outcomes.
- **Rules with a working draft**: rules that already had a working draft. Every rule ever published from
  the Rule Builder has one, so this lists all of them; only those in the first list have changes (see
  *Before you upgrade*).
- **Drafts opened** (with `-WhatIf`: **Draft would be opened**): published rules that had no draft.
- **Skipped (declined)**: rules where you declined a write under `-Confirm`; not published.
- **Failed**: `Failed: <rule id> <rule name>: <message>`.

Under `-WhatIf` the lists show what would change, and drafts are checked for edits exactly as in a real
run. For a published rule without a draft, the estimate is read from the rule's own rows, which the new draft
would copy. The exit code is 1 when any rule failed, 0 otherwise; rules skipped for draft edits do not count
as failed.

## Running it again

It is safe to re-run, and re-running is how an interrupted or partly failed run is finished:

- Actions without On match / On no match are left alone, so work already done is not repeated.
- If a run was interrupted while building a tree, the next run completes that tree (tree rows get stable
  ids) instead of adding a second one.
- An enforcing rule is republished whenever its published version still uses On match / On no match, even
  if its draft needs no change. So a rule whose publish failed (fix the problem the message names first),
  or whose run stopped before the publish, is published by the next run.
- A rule skipped for draft edits is checked again: after you publish or discard its changes, the next run
  converts and publishes it.
- Once every enforcing rule's published version is converted, a further run writes nothing.

## For maintainers

The `@odata.bind` names the script sends are the lookups' schema names from
`pipelines/Configure-RuleAuthoring.ps1`, and they are case-sensitive: `asx_RuleAction@odata.bind` on
`asx_actionconditiongroups`, and `asx_ActionConditionGroup@odata.bind` and `asx_Outcome@odata.bind` on
`asx_actionconditiontests`. The script does not create nested groups, so `asx_ParentGroup` is never bound.

The draft-edit check walks a draft along the same parent -> child edges as `RuleSnapshot.Edges` in
`Ascentix.RulesEngine.Core/Publication/RuleSnapshot.cs` (without its `asx_tableconfig` edge); the list in
the script (`$DraftEdges`) must be kept in step with it. A Rule Builder publish keeps the draft's row ids in
the revision (only the rule id is swapped, `RuleDrafts.Reidentify`); `asx_OpenRuleDraft` and Restore create
rows with new ids, which is why the check has two cases. The script converts a draft's actions before it
renames its outcomes, so the first write of a run stopped part-way is one of its own stable-id Fires when
roots, which marks the draft as already checked.

`Test-ConvertRulesToOutcomes.ps1` runs the script against an in-memory mock of the Web API, with no
environment or credentials; CI runs it on every build.
