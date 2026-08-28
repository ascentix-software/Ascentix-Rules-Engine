# Security Policy

The Ascentix Rules Engine runs as a Dataverse plug-in inside customer environments.
It reads rule configuration as the system user, and, for rules configured that way, performs
writes as the system user. If you find a problem in it, a private report is much better than a
public one.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a suspected vulnerability**, and please do not
post details in a pull request, a discussion, or on social media before a fix has had a chance
to ship.

Use either of these private channels:

1. **GitHub private vulnerability reporting**, at
   <https://github.com/ascentix-software/Ascentix-Rules-Engine/security/advisories/new> (the
   repository's **Security** tab → **Report a vulnerability**). This is the preferred route: it
   keeps the report, the discussion, and any fix coordination in one private place.
2. **Email** <info@ascentix.ca> with `SECURITY` in the subject line, if you would rather not use
   GitHub or the form is unavailable.

Everything that is *not* a vulnerability (bugs, questions, feature requests) goes in the public
tracker at <https://github.com/ascentix-software/Ascentix-Rules-Engine/issues>.

Helpful things to include, if you have them:

- What an attacker can do, and what privilege they need to start (an anonymous caller, any
  licensed user, a user holding **Rules Engine Author**, a System Customizer, an administrator).
- The affected component: the plug-in / engine, a Custom API (`asx_RunRules`,
  `asx_ValidateRule`, `asx_ReadRules`, `asx_SyncSteps`), the Rule Builder web resources, or the client form
  library.
- The solution version, from the environment's **Solutions** list.
- Reproduction steps, and the exact error or response text copied verbatim.
- Please **do not** include customer data, record contents, tokens, connection strings, or
  environment credentials. Rule names, messages, and error text are enough; redact anything else.

## What to expect

The product is a free community tool in open beta, maintained by one person, and it is
provided **as-is** under Apache-2.0. There is no SLA, no remediation window, no undertaking to
reply, and no bug bounty.

That is not a reason to keep a finding to yourself. The product carries no telemetry and has no
other reporting channel, so a report is the only route by which a problem in it can become known,
and the private channels above exist precisely so that route does not have to be a public one.

If a fix does ship, it goes out in a normal beta release and is described in `CHANGELOG.md`;
reporters are credited there by name unless they ask not to be.

Coordinated disclosure is appreciated, because publishing a finding before a fix exists mostly
hurts the people running the software. No embargo is being asked of you, though, and nothing here
asks you to stay quiet indefinitely. When and whether you publish is your call.

Please do not test against environments you do not own.

## Supported versions

Only the **most recent published beta release** is in scope. Older beta releases are not
patched, and nothing is backported to them. Upgrade to the current release first and confirm the
issue still reproduces there. The beta is intended for **non-production environments** (see
[Beta Limitations](https://ascentix.ca/power-platform/rules-engine/beta-limitations)).

Only the **managed** solution package published at
<https://ascentix.ca/power-platform/rules-engine/download> is a supported artifact.
Builds made from this source tree, and unmanaged installs, are not.

## Known security characteristics

These are **documented, intentional** behaviours. A researcher will find them, and it is worth
knowing up front that they are disclosed design decisions rather than spending time writing them
up as novel findings. The detail lives in `docs/Security.md` and on the
[Beta Limitations](https://ascentix.ca/power-platform/rules-engine/beta-limitations),
[Security Roles](https://ascentix.ca/power-platform/rules-engine/security-roles), and
[Evaluation Context](https://ascentix.ca/power-platform/rules-engine/evaluation-context)
documentation pages. If you believe one of them is worse than documented, or that a stated guard
can be bypassed, that *is* worth reporting.

**Rule configuration is read as the system user.** The enforcement plug-in loads the engine's own
rule configuration tables (the `asx_*` tables listed in `docs/Schema.md`) through the system-user
service, not the caller's. This is deliberate:
otherwise a caller without read access to `asx_rule` would load zero rules and enforcement would
silently not apply. It also means a user's Author/Reader role assignment has no bearing on
whether rules are enforced against that user's writes, only on whether that user can read or
edit the configuration directly.

**Business-data traversal runs as the caller by default.** With the default `User` evaluation
context, the triggering record and everything reached through the rule's Table Config tree are
read in the calling user's context. A rule therefore sees only what that user can see, and rule
outcomes are *not* identical across users with different security roles: a Row Count minimum can
pass for a read-restricted user and block for an administrator. This is the deliberate trade-off
that keeps the engine from becoming a read-permission side channel.

**System evaluation context is delegated system access, and it bypasses field-level security.**
A rule set to `System` traverses *and executes its Create / Update / Delete actions* as SYSTEM.
System writes do not respect column security profiles, so a field mapping onto a secured column
succeeds regardless of the publisher's or the caller's field-level permissions. There is no code
guard against this in the beta; it is disclosed rather than blocked. **Treat anyone who can
publish a System-context write rule as system-customizer-equivalent.**

**Publishing a System-context write rule is privilege-gated (`SEC_SYSWRITE_PRIV`).** The
publishing user (resolved from `InitiatingUserId`, so an impersonated publish cannot launder it)
must hold the matching privilege at **organization (Global) depth** on every write target:
CreateRecord → Create, UpdateRecord → Write, DeleteRecord → Delete. The contract is that a rule
never lets its publisher exceed what the publisher could do directly. One documented exemption: a
root-targeted `UpdateRecord` on a rule *without* the OnDelete trigger, because that write is an
in-place merge inside the saving user's own save and never consults the evaluation context; the
same action *with* OnDelete is gated. `asx_ValidateRule` surfaces the requirement to all callers
as an informational `SEC_SYSWRITE_REQ` warning. `docs/Security.md` carries an audit query for
listing published System-context write rules and who published them.

**Enforcement steps are generated in the environment, outside the solution.** Publishing a rule
creates `SdkMessageProcessingStep` records named `Ascentix.RulesEngine: <table> <message>` via a
system-context registration plug-in, so rule authors need no privileges on platform tables. The
`asx_SyncSteps` Custom API reconciles or removes them and is gated on
`prvWriteSdkMessageProcessingStep`; it reports, but never re-enables, steps an administrator has
deactivated. Because these steps reference the plug-in type, uninstalling the solution is
dependency-blocked until they are removed.

## Out of scope

- Vulnerabilities in Microsoft Dataverse, Power Platform, or Power Pages themselves. Report
  those to Microsoft (<https://msrc.microsoft.com/>). They are still worth mentioning here if
  they change how the engine should behave.
- Findings that only reproduce against an unmanaged or self-built install.
- Behaviours listed above as documented and intentional, unless you can show they are more severe
  than documented or that a stated guard can be bypassed.
- Missing hardening that is already recorded as a beta limitation. For example, the absence of
  an org-level enforcement switch.
