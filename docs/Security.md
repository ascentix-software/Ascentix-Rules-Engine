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
- **System evaluation context = delegated system writes.** A rule with
  `asx_evaluationcontext = System` traverses **and executes its write actions** as SYSTEM.
  Treat anyone who can publish such a rule as a system-customizer-equivalent. Two guards apply:
  1. **Publish-time privilege gate (`SEC_SYSWRITE_PRIV`).** Publishing a System-context rule
     that carries write actions requires the *publishing user* (`InitiatingUserId`, which
     an impersonated publish cannot launder) to hold the matching privilege at
     **organization (Global) depth** on each write target: CreateRecord → Create,
     UpdateRecord → Write, DeleteRecord → Delete. The contract: a rule never lets its publisher
     exceed what the publisher could do directly. A System rule's writes reach any row
     org-wide, so only Global depth matches. Root-targeted UpdateRecord on rules *without* the
     OnDelete trigger is exempt (the in-place merge lands inside the saving user's own save and
     never consults the evaluation context); the same action **with** OnDelete is gated (on
     Delete there is no in-flight Target, so the write falls through to the SYSTEM service).
     `asx_ValidateRule` surfaces the requirement to every caller as an informational
     `SEC_SYSWRITE_REQ` warning and evaluates the blocking check against the *caller*.
     The authoritative check re-runs for the actual publisher at publish time.
  2. **Disclosure: field-level security is bypassed.** SYSTEM writes do not respect column
     security profiles. If a System-context rule's field mapping writes a secured column, the
     write succeeds regardless of the publisher's or caller's field-level permissions. There is
     no code guard for this in beta; factor it into who may hold the Author role.

  **Audit query** to list published System-context rules with write actions and their publishers:
  ```
  GET /api/data/v9.2/asx_rules?$filter=statuscode eq 753840000 and asx_evaluationcontext eq 2
    &$select=asx_name,_createdby_value,_modifiedby_value
    &$expand=asx_rule_ruleaction($filter=asx_isactive eq true and
       (asx_actiontype eq 5 or asx_actiontype eq 6 or asx_actiontype eq 7);
       $select=asx_actiontype,asx_targettable)
  ```
  The gate ships in the first external release, so no published release predates it. Rules
  published before it was introduced keep running; run the audit query after upgrading and
  re-publish anything questionable.

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
consequence: **Author is a trusted role.** The field-level-security disclosure above has no code
guard, so who holds Author is the only thing bounding it.

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
