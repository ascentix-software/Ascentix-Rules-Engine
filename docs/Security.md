# Ascentix Rules Engine Security Model

## Execution context
- **Rule-config reads run as SYSTEM.** `RulesEnginePlugin` loads the config tables
  (`asx_rule`, `asx_conditiongroup`, `asx_rulecondition`, `asx_tableconfig`, `asx_ruleaction`,
  and the search/node-filter tables) via the system-user service. Enforcement therefore never
  silently fails for a caller who lacks read access to the config.
- **Business-data traversal runs as the CALLER.** `RootEntityBuilder` and `QueryExecutor` read
  the triggering record and its related data in the calling user's context, so a rule sees only
  data that user can read. (Trade-off of not using full system-context evaluation.)
- **Step registration runs as SYSTEM** (the registration plugin).
- **System evaluation context = trusted author delegation.** A rule with
  `asx_evaluationcontext = System` traverses data and executes its write actions as
  SYSTEM. An administrator granting the Author role authorizes that user to decide
  when those writes should occur. Publication validates the definition; it does not
  require the author to hold business-table privileges for each configured action.
  SYSTEM also bypasses column-security profiles.
- **Authoring API access uses Dataverse privileges.** Read published requires rule
  Read; open/restore draft requires rule Write; copy requires rule Create; delete
  requires rule Delete. These are platform Custom API execution requirements.
  There is no additional caller-access or publisher-privilege veto in the handler.
- **Workflow and definition validation remain.** Published rules are edited through
  working drafts; publication validates the current saved definition. Saves and
  publication accept the latest version without stale ETag/hash/version checks.
  Publication metadata and revision-table access use platform permissions rather
  than plugin immutability restrictions. Cleanup stays transactional.

## Solution roles
The two shipped roles, the privileges each grants, the 10 config tables they cover, and why both
are additive at **Organization** depth: see *Security Roles* in the guide. That page is the single
authoritative statement of the grants; do not restate them here.

> Note: Dataverse auto-attaches a small set of SharePoint document-integration privileges
> (`prv*SharePointData`, `prvReadSharePointDocument`) to every role in environments with
> document management enabled. These are platform-managed, present on all roles, and unrelated
> to the rules-engine grants above.

## Who gets which role
See *Security Roles* in the guide for what each role is for, why authors need no platform-table
privileges, and why nothing in the engine's runtime requires Reader. The maintainer-facing
consequence: **Author is a trusted role.** System-context behavior is an explicit capability of that role.

The roles ship in the `AscentixRulesEngine` solution but are **assigned by administrators** in
the target environment.

## Admin bypass (migrations / imports)
The engine has no custom bypass switch. To run a migration or bulk import without rule
enforcement:
- **SDK / Configuration Migration / bulk import:** an admin with the `prvBypassCustomBusinessLogic`
  privilege sets **`BypassCustomPluginExecution`** on the request to skip custom plugins
  (including this engine) for that operation. This is the platform's native mechanism.
- **Integrations:** `asx_channels` is not an integration bypass. Its only distinction is **Portal**
  (Power Pages) vs **Standard** (everything else: people, integrations and service principals
  alike), because Dataverse does not reliably tell a human apart from an application user. Use
  `BypassCustomPluginExecution` above to exempt integration traffic.
- **Lifecycle:** keep a rule in **Draft** (or **Archived**), or outside its effective window, to
  suppress it without deleting it.

> There is no way to suspend just this engine without disabling all custom plugins. The supported
> emergency stop is to unpublish the rule or deactivate its generated enforcement step.
