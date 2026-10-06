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

1. **Where it edits.** A published rule (it has a published revision, or its status is Published) is edited
   through its working draft; the script opens one with `asx_OpenRuleDraft` if the rule has none. A rule
   that was never published is edited directly.
2. **Names the outcomes.** Each outcome (a top-level validation group, not a "Run only when" group) needs a
   unique name. A blank name becomes "Outcome N" (the smallest N not already used); a repeated name,
   ignoring case, gets " (2)", " (3)" and so on.
3. **Builds each action's Fires when tree.** For each action that still has On match / On no match set and
   no tree:
   - **On match** becomes a root **ALL** group with one test "*outcome* is true" per outcome. A rule with
     no outcomes gets an empty ALL group, which means "always, when the rule runs".
   - **On no match** becomes a root **ANY** group with one test "*outcome* is false" per outcome. With no
     outcomes the action could never fire, so it is **deactivated** and listed.
   - On match / On no match is then cleared. An action that already has a tree keeps it.
4. **Republishes.** A rule that is currently enforcing (status Published) and whose draft changed is
   published again; the normal publish checks run. A rule that was published before but is not enforcing
   now is converted in its draft and left unpublished. A rule whose publish fails is listed with the
   Dataverse message and the script moves on to the next rule.

## Before you upgrade

Publish or discard every pending working-draft edit. The script republishes each enforcing rule's working
draft, so any unpublished edits in it would go live with the conversion.

Run the script with `-WhatIf` first (it can run before or after the upgrade; it writes nothing). Its
"Rules with a working draft" list shows every rule that has a draft, so you can check each one.

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
prints only the host name of the environment. Add `-Confirm` to approve each write one at a time; a rule
whose draft you decline to open is reported as `skipped`. A token lasts about an hour: if it expires during
a long run, get a new one and run the script again (see below).

## Output

Each rule gets one line (`converted`, `published`, `no change` or `FAILED: <message>`), followed by a
summary:

- **Converted**: rules whose outcomes or actions changed.
- **Published**: enforcing rules that were republished.
- **Deactivated**: `<rule> / <action>` for each On no match action on a rule with no outcomes.
- **Rules with a working draft**: rules that already had a working draft (check these; see above).
- **Drafts opened** (with `-WhatIf`: **Draft would be opened**): published rules that had no draft.
- **Failed**: `Failed: <rule id> <rule name>: <message>`.

Under `-WhatIf` the lists show what would change. For a published rule without a draft, the estimate is
read from the rule's own rows, which the new draft would copy. The exit code is 1 when any rule failed,
0 otherwise.

## Running it again

It is safe to re-run. Actions without On match / On no match are left alone, and a rule whose draft needed
no change is not republished, so a second run on a converted environment writes nothing. If a run was
interrupted while building a tree, the next run completes that tree (tree rows get stable ids) instead of
adding a second one.

A rule listed under **Failed** at the publish step is already converted in its working draft. Fix the
problem the message names, then publish the rule from the Rule Builder: a re-run does not republish it,
because its draft no longer needs a change.

## For maintainers

The `@odata.bind` names the script sends are the lookups' schema names from
`pipelines/Configure-RuleAuthoring.ps1`, and they are case-sensitive: `asx_RuleAction@odata.bind` on
`asx_actionconditiongroups`, and `asx_ActionConditionGroup@odata.bind` and `asx_Outcome@odata.bind` on
`asx_actionconditiontests`. The script does not create nested groups, so `asx_ParentGroup` is never bound.

`Test-ConvertRulesToOutcomes.ps1` runs the script against an in-memory mock of the Web API, with no
environment or credentials; CI runs it on every build.
