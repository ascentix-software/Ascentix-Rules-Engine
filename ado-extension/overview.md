# Rules Transport Tasks

Move [Ascentix Rules Engine](https://ascentix.ca/power-platform/rules-engine) rules between Dataverse environments from Azure Pipelines.

- **Rules Transport Export** (`RulesTransportExport@0`) writes the published rules of one or more rule sets to a `.asxrules.json` package.
- **Rules Transport Import** (`RulesTransportImport@0`) imports each rule in a package into the target environment and publishes it there, one rule at a time.

## Requirements

- The Ascentix Rules Engine solution in both environments. The target must run the same version as the source, or newer.
- [Power Platform Build Tools](https://marketplace.visualstudio.com/items?itemName=microsoft-IsvExpTools.PowerPlatform-BuildTools) in your organization, for the **Power Platform** service connection. Client secret and workload identity federation both work.
- The connection's application user holds the **Rules Engine Author** role in each environment.

## Example

```yaml
steps:
  - task: RulesTransportExport@0
    inputs:
      connection: Contoso-DEV
      ruleSets: Billing
      outputPath: $(Build.ArtifactStagingDirectory)/rules.asxrules.json

  - task: RulesTransportImport@0
    inputs:
      connection: Contoso-PROD
      packagePath: $(Build.ArtifactStagingDirectory)/rules.asxrules.json
```

## Import inputs

| Input | Values | Default |
|---|---|---|
| `ruleSets` | Rule set names, one per line | Every rule set in the package |
| `dryRun` | `true` reports what would change and writes nothing | `false` |
| `targetChanges` | `skip` reports a rule changed in the target as a conflict and leaves it. `overwrite` imports over it | `skip` |
| `missingRules` | `leave`, or `archive` to archive published target rules in the selected sets that the package doesn't contain | `leave` |
| `ownerTeam` | Team that owns rules created in the target | The connection's application user |

Export takes published rules only. Draft and archived rules are skipped with a warning.

Each import attaches a summary to the pipeline run and writes `rules-import-report.json` and `rules-import-report.md` next to the package. A rule that fails fails the step. Conflicts and collisions mark it as succeeded with issues.

## Documentation

[Moving Rules Between Environments](https://ascentix.ca/power-platform/rules-engine/moving-rules-between-environments) covers rule sets, the service connection and the import options in full.
