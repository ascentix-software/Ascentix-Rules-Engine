---
title: Moving Rules Between Environments
section: Administering
order: 309
slug: moving-rules-between-environments
---

# Moving Rules Between Environments

Rules are built in a development environment and promoted to test and production. The
**Rules Transport Tasks** extension for Azure DevOps does this from a pipeline: one task writes
the published rules of one or more **rule sets** to a package file, another reads the package and
imports each rule into the target environment. The solution must be installed in both
environments (*Installation*).

## Rule sets

A **rule set** is a named group of rules that move together. A rule is in one rule set or none, and
only rules in a rule set can be exported.

- Create, rename and delete rule sets on the hub's **Rule sets** tab, which also shows where and
  when each set was last imported. A set's page adds and removes its rules (*The Hub*).
- On the hub's **Rules** tab, select rules and choose **Move to rule set** to move them together.
  The **Rule set** column and filter show which set each rule is in.
- In the rule editor, the **Rule set** chip sets one rule's set (*Editor Layout*).
- Changing a rule's set doesn't need a working draft: a published rule's set can be changed while
  it keeps enforcing.
- A rule set can't be deleted while it has rules.

## Set up the pipeline

Before you start, install Microsoft's **Power Platform Build Tools** extension in your Azure DevOps
organization. It provides the **Power Platform** service connection type the tasks sign in with.

1. Install **Rules Transport Tasks** from the
   [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=AscentixSoftware.rules-transport-tasks).
2. Create a **Power Platform** service connection for each environment you read from or write to.
   Both authentication types work: a client secret, or workload identity federation (no secret to
   store or rotate).
3. In each environment, add the connection's service principal as an **application user** and
   give it the **Rules Engine Author** role (*Security Roles*). Export reads rules; import creates,
   updates, publishes and archives them. Import needs Write on **Rule**, and Create as well for a
   rule that is new in the target.

## The two tasks

**Rules Transport Export** (`RulesTransportExport@0`)

| Input | Notes |
|---|---|
| `connection` | The service connection to export from |
| `ruleSets` | Rule set names, one per line |
| `rules` | Optional rule names, one per line. Narrows the rule sets to these rules |
| `outputPath` | Where to write the `.asxrules.json` package |

Only **Published** rules are exported. A draft or archived rule in a selected set is skipped with a
warning, and so is a name in `rules` that matches no rule.

**Rules Transport Import** (`RulesTransportImport@0`)

| Input | Default | Notes |
|---|---|---|
| `connection` | | The service connection to import into |
| `packagePath` | | The package to import |
| `ruleSets` | Every rule set in the package | Rule set names, one per line |
| `dryRun` | `false` | Runs every check and reports what would happen, changing nothing |
| `targetChanges` | `skip` | `skip` reports a conflict; `overwrite` imports over the target's version |
| `missingRules` | `leave` | `leave` warns about target rules the package lacks; `archive` archives them |
| `ownerTeam` | | Name of the team that owns newly created rules. Otherwise the connection's application user does |

A pipeline that promotes the `Finance` rule set from dev to test:

```yaml
steps:
  - task: RulesTransportExport@0
    displayName: Export Finance rules from dev
    inputs:
      connection: 'Dataverse-Dev'
      ruleSets: |
        Finance
      outputPath: '$(Build.ArtifactStagingDirectory)/rules.asxrules.json'

  - task: RulesTransportImport@0
    displayName: Check the import against test
    inputs:
      connection: 'Dataverse-Test'
      packagePath: '$(Build.ArtifactStagingDirectory)/rules.asxrules.json'
      dryRun: true

  - task: RulesTransportImport@0
    displayName: Import into test
    inputs:
      connection: 'Dataverse-Test'
      packagePath: '$(Build.ArtifactStagingDirectory)/rules.asxrules.json'
      targetChanges: skip
      missingRules: leave
```

The import runs one rule at a time, so a rule that fails doesn't stop the others; the task fails at
the end and names the rules that failed.

## What moves and what doesn't

Moves with each rule:

- Its **published definition**: conditions, actions, outcomes, triggers and messages.
- Its **rule set**, created in the target when the target has no set of that name. If you rename a
  set in the target, the next import creates a set with the source's name and moves the package's
  rules into it.
- Its **schedule definition** (the pattern, time and days), not when it last or next runs.
- Its **data models**. An imported rule gets **private copies** of its data models. A shared model
  in the target is never changed, so importing can't alter another rule.

Stays behind:

- Working drafts, run history and diagnostics.
- **Environment variable** values (*Installation*).
- Owners. A new rule is owned by the `ownerTeam`, or by the connection's application user.

A rule keeps its identifier across environments. That is how the import recognises a rule it has
imported before.

### Record references

A rule can store the identifier of a specific record, for example a condition comparing a lookup
to one account. Record identifiers differ between environments, so the import checks them first:

- If the record **exists in the target**, the rule imports.
- If it **doesn't**, that rule fails and nothing is written for it.
- If the table of the lookup **can't be determined**, the rule imports and the report carries a
  warning to check the value.

### Engine versions

A package exported by a **newer** engine than the target's installed solution is refused. Upgrade
the target first (*Installation*). A package from an older or equal version imports.

## Conflicts, collisions and missing rules

Each rule ends with one outcome:

| Outcome | Meaning |
|---|---|
| `created` | The rule is new in the target and is now published |
| `updated` | The target rule changed and a new version is published |
| `unchanged` | The target already has this definition |
| `conflict` | The rule was left alone (below) |
| `collision` | A different rule with the same name is already in that rule set, or outside any set, in the target. The rule isn't imported |
| `wouldCreate`, `wouldUpdate` | What a `dryRun` would have done |

### Conflicts

By default (`targetChanges: skip`) a rule is reported as a conflict, and left alone, when the target
has:

- an **open working draft** for it,
- the rule **published in the target**, not imported from a package,
- the rule **archived**,
- the rule **unpublished** in the target, or
- the rule, but it was **never published or imported**.

With `targetChanges: overwrite` the package wins: the definition replaces the target's draft or
published version and is published as a new version. A rule's business table can't change, so a
package whose rule runs on a different table fails for that rule even with `overwrite`.

### Missing rules

`missingRules` decides what happens to rules in the selected rule sets that the package doesn't
carry:

- `leave` keeps them running and lists each one as a warning.
- `archive` archives them. Only **Published** rules are archived: drafts and already archived rules
  are never touched, and neither is a rule whose name matches a rule in the package.

A rule the export skipped (a **Draft** or **Archived** rule in the source) isn't in the package
either, so `archive` also archives its published copy in the target.

`archive` is refused for a package exported with the `rules` input, since that package isn't the
whole of its rule sets. Export whole rule sets to use it.

## Reading the report

The import writes two files next to the package: `rules-import-report.json` (every rule's outcome,
messages and the version now published in the target) and `rules-import-report.md`, which is also
attached to the pipeline run as a summary. The report groups rules by outcome, then lists the rules
that were archived (or would be, in a dry run), the rules left alone, and any that failed with the
reason.

The task also logs one line per rule with its outcome and messages. Each conflict, collision and
left-alone rule, and each record whose table couldn't be determined, is raised as a pipeline
warning, and a run with warnings ends as *succeeded with issues*. A run with any failed rule fails.
The report is written even when the run fails part way, listing what was done before the failure.

Run with `dryRun: true` first. Without writing to the target, it reports every outcome and checks
each rule's validation, record references, conflicts and any pending data update. A refused
schedule shows only on the real run.
