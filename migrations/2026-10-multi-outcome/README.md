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

## Before you upgrade

Every rule that has ever been published from the Rule Builder keeps a working draft, so the script's
"Rules with a working draft" list includes all of them. The script republishes every enforcing rule from
its draft, so any saved but unpublished change in a draft would go live with the conversion. Before you
upgrade, open each rule that has saved but unpublished changes and **Publish** or **Discard** them.

Run the script with `-WhatIf` first (it can run before or after the upgrade; it writes nothing) to see
what it would change.

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

Add `-Confirm` to approve each write one at a time. If you decline any write for a rule (including opening
its working draft), that rule is not published, nothing you declined is reported as done, and the rule is
listed under **Skipped (declined)**. Its draft may be partly converted; run the script again (without
declining) to finish it.

## Output

Each rule gets one line (`converted`, `published`, `no change`, `skipped (declined)` or
`FAILED: <message>`), followed by a
summary:

- **Converted**: rules whose outcomes or actions changed.
- **Published**: enforcing rules that were republished (their published version was not yet converted).
- **Deactivated**: `<rule> / <action>` for each On no match action on a rule with no outcomes.
- **Rules with a working draft**: rules that already had a working draft. Every rule ever published from
  the Rule Builder has one, so this lists all of them (see *Before you upgrade*).
- **Drafts opened** (with `-WhatIf`: **Draft would be opened**): published rules that had no draft.
- **Skipped (declined)**: rules where you declined a write under `-Confirm`; not published.
- **Failed**: `Failed: <rule id> <rule name>: <message>`.

Under `-WhatIf` the lists show what would change. For a published rule without a draft, the estimate is
read from the rule's own rows, which the new draft would copy. The exit code is 1 when any rule failed,
0 otherwise.

## Running it again

It is safe to re-run, and re-running is how an interrupted or partly failed run is finished:

- Actions without On match / On no match are left alone, so work already done is not repeated.
- If a run was interrupted while building a tree, the next run completes that tree (tree rows get stable
  ids) instead of adding a second one.
- An enforcing rule is republished whenever its published version still uses On match / On no match, even
  if its draft needs no change. So a rule whose publish failed (fix the problem the message names first),
  or whose run stopped before the publish, is published by the next run.
- Once every enforcing rule's published version is converted, a further run writes nothing.

## For maintainers

The `@odata.bind` names the script sends are the lookups' schema names from
`pipelines/Configure-RuleAuthoring.ps1`, and they are case-sensitive: `asx_RuleAction@odata.bind` on
`asx_actionconditiongroups`, and `asx_ActionConditionGroup@odata.bind` and `asx_Outcome@odata.bind` on
`asx_actionconditiontests`. The script does not create nested groups, so `asx_ParentGroup` is never bound.

`Test-ConvertRulesToOutcomes.ps1` runs the script against an in-memory mock of the Web API, with no
environment or credentials; CI runs it on every build.
