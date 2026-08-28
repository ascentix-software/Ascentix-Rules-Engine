# Ascentix Rules Engine

A managed solution for **Microsoft Dataverse** that lets an administrator author rules as
configuration rather than code: validation, record automation and form behaviour, with no
plug-in project and no form JavaScript. Rules are enforced on the server, so they hold for form
saves, the Web API, integrations and bulk imports alike.

Free, Apache-2.0 licensed, currently in **open beta**.

**[Documentation](https://ascentix.ca/power-platform/rules-engine/)** ·
[Download](https://ascentix.ca/power-platform/rules-engine/download) ·
[Beta limitations](https://ascentix.ca/power-platform/rules-engine/beta-limitations)

![Rule editor for "Order total within credit limit": breadcrumb, Save/Reload/Validate/Publish actions, a properties band (Table sample_order, Triggers, Channels All), a DATA MAP row (Orders, sample_customer, sample_orderline, sample_product), a WHEN Execution conditions zone, a WHEN Validation conditions zone with a "Credit check" ALL·AND group and one condition, and a THEN Actions zone with a "Block save" action.](docs/guide/images/02-04-editor-layout-01.png)

## What it does

Business logic moves out of your components and into the data layer, where it is visible and
changeable without a deployment.

Dataverse business rules stop at the record in front of you. Synchronous workflows are limited,
and Power Automate is asynchronous. As soon as a policy needs *related* data (the order's lines,
the account's parent, the customer's credit limit), or complex querying run synchronously, you are
writing a plug-in or a form script. This engine covers three jobs that normally mean three
different pieces of code:

- **Validation:** stop a save that shouldn't happen, and explain why.
- **Automation:** create a follow-up record, update a related row, delete one that no longer
  applies.
- **Guidance:** show, hide or require a field as someone fills in a form, or surface a message
  without stopping them.

A rule is scoped to a table, declares a tree of conditions (WHEN) and a set of actions (THEN),
and reaches lookup and child records through a reusable **Table Config** tree that several rules
can share. The conditions that block a bad save are the same ones that drive a field's visibility
or write a related record. You choose by picking the action, not by writing a different kind of
code.

Rules are Draft until published, and unpublishing takes effect in the same transaction, which is
the supported emergency stop. The engine's configuration lives in its own `asx_` tables and adds
no columns to yours.

[Core Concepts](https://ascentix.ca/power-platform/rules-engine/core-concepts) covers the
vocabulary: rules, conditions, actions, Table Configs and severity.
[Triggers & Channels](https://ascentix.ca/power-platform/rules-engine/triggers-and-channels)
covers when a rule fires, and
[Custom APIs](https://ascentix.ca/power-platform/rules-engine/custom-apis) documents the four.

## Status: open beta

Current release **`0.0.0.1`** (2026-08-28), detailed in [CHANGELOG.md](CHANGELOG.md). Intended for
non-production environments. The supported envelope is roughly 100 published rules per
environment and 5,000 traversed related rows per save. Rules re-evaluate on root-table writes
only, and there is no supported rule transport between environments.

There is no SLA and no warranty: the software is provided as-is under the Apache-2.0 licence.
Read [Beta Limitations](https://ascentix.ca/power-platform/rules-engine/beta-limitations)
before installing. It is the complete list, not a summary.

## Installing

Install the **managed** solution zip; do not build your own package for a real environment.
[Download it, with its SHA-256](https://ascentix.ca/power-platform/rules-engine/download),
then follow
[Installing, Verifying & Uninstalling](https://ascentix.ca/power-platform/rules-engine/installation),
which covers the import, the two shipped security roles, a post-import verification checklist, the
upgrade path, and the uninstall sequence.

Rules are then authored in the **Rules & data model** hub inside the shipped model-driven app:

![Rules & data model hub: Rules and Table configurations tabs, a New rule button, search box, Table and Status filters, and a list with one rule "Order total within credit limit" on sample_order, status Draft, triggers On Create/On Form/On Update.](docs/guide/images/02-02-the-hub-01.png)

### Verifying a release

Official artifacts are signed with a key that is not in this repository; its public half is, at
`Ascentix.RulesEngine.Plugin/Ascentix.Release.publickey`. Unzip the managed solution and
check the plug-in assembly under `PluginAssemblies/`:

```powershell
$dll = "PluginAssemblies\<folder>\Ascentix.RulesEngine.Plugin.dll"
([System.Reflection.AssemblyName]::GetAssemblyName($dll).GetPublicKeyToken() |
    ForEach-Object { $_.ToString("x2") }) -join ""
```

That should print `67f2dcfd2e8488af`. A build made from this repository will **not** match, by
design (see below). This is an identity check rather than a certificate chain; for integrity, use
the `SHA256SUMS` published with each release.

## Building from source

Prerequisites: **.NET SDK 10.x** (the `.slnx` solution format needs 9.0.200+) and **Node 24**.

```
dotnet build ValidationEngine.slnx
dotnet test tests/Ascentix.RulesEngine.Tests/Ascentix.RulesEngine.Tests.csproj

cd client
npm ci
npm run build      # web-resource bundles into client/dist/
npm test
npm run typecheck  # covers all three tsconfigs
```

None of that needs a Dataverse environment. Dataverse requires plug-in assemblies to be
strong-name signed, so an ordinary build signs with the **development key** committed at
`Ascentix.RulesEngine.Plugin/Ascentix.Dev.snk`. It exists so a clean clone builds and
the tests run, and it signs nothing anyone should trust.

The live contract suite (`npm run test:dev`) and the Playwright suite (`npm run test:e2e`) need
credentials for a Dataverse development environment that the harness creates and sweeps fixtures
in. They cannot be pointed at an org you care about.

**Building is not releasing.** The shipped managed solution is *exported* from the maintainer's
Dataverse environment by the maintainer's release build, which stamps the version and produces
the signed zip; `Solutions/` in this repo is a generated mirror of that export, never
hand-edited. A supported release artifact cannot be produced from this source tree alone.

## Contributing and reporting

- **Bugs and questions:** open a
  [GitHub issue](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues) using one of
  the templates. The product carries no telemetry, so an issue is the only way a problem in it
  becomes known. Please don't paste customer data, credentials, or record contents.
- **Security:** never in a public issue. Use
  [private reporting](https://github.com/ascentix-software/Ascentix-Rules-Engine/security/advisories/new)
  or info@ascentix.ca. [SECURITY.md](SECURITY.md) has the policy and the known security
  characteristics.
- **Code:** [CONTRIBUTING.md](CONTRIBUTING.md) has the build and testing layers, the schema
  contract, and the conventions. [CONTEXT.md](CONTEXT.md) is the domain glossary: the code,
  tests, docs and pull requests all use those terms with those meanings, so it is the fastest way
  in.

The repository has one maintainer, so issues and pull requests get attention when time allows,
which may be a while, and may be never for any given one. That is worth knowing before you sink
effort into a large change.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The NOTICE lists the third-party
components redistributed in the solution, and carves out the Fluent UI icon artwork, which
Microsoft licenses separately and which this project cannot sublicense.
