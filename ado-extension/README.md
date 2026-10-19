# Ascentix Rules Transport

Move Ascentix Rules Engine rules between Dataverse environments from an Azure Pipeline.

- **Ascentix Rules Export** writes the published rules of one or more rule sets to a `.asxrules.json` package.
- **Ascentix Rules Import** reads a package and imports each rule into the target environment, one rule at a time.

Both tasks sign in with a Power Platform Build Tools service connection (client secret or workload identity federation) and need the Ascentix Rules Engine solution installed in the environments they talk to.
