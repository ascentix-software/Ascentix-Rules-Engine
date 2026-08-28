# Contributing

## Expectations

- **One maintainer.** Issues and pull requests get attention as time allows. There is no SLA.
- **[GitHub Issues](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues) is the
  tracker.** Bugs, questions and feature requests go there. Templates for a bug report and a
  question are in `.github/ISSUE_TEMPLATE/`. To file privately instead, email <info@ascentix.ca>.
- **Open an issue before building anything substantial.** A new condition type, a schema change,
  a change to evaluation semantics, or a refactor across modules may conflict with work in
  progress or with a design decision recorded in `docs/`. Small, self-contained fixes (a bug with
  a failing test, a typo, a documentation correction) are welcome directly as a pull request.
- **Security problems do not go in issues or pull requests.** Report them privately: the
  repository's **Security** tab →
  [Report a vulnerability](https://github.com/ascentix-software/Ascentix-Rules-Engine/security/advisories/new),
  or email <info@ascentix.ca> with `SECURITY` in the subject. See [SECURITY.md](SECURITY.md).
- **Contributions are accepted under Apache-2.0** (see [LICENSE](LICENSE)), per section 5 of the
  license: anything you deliberately submit for inclusion is licensed under those terms, with no
  additional conditions.

## The vocabulary

`CONTEXT.md` is the domain glossary: Rule, node, Table Config tree, pushdown variant, in-flight
batch, verdict, settle, and so on. The code, tests, documentation, commit messages and pull
requests use those words with those meanings. Read it before the engine.

Architectural discussion uses the usual design vocabulary (module, interface, seam, adapter,
depth, leverage, locality) and does not redefine it.

## Repository layout

| Path | Contents |
|---|---|
| `Ascentix.RulesEngine.Core/` | The engine: loaders, evaluation, actions, resolution, validation, localization, schema names |
| `Ascentix.RulesEngine.Plugin/` | The Dataverse plug-in. It compiles all of Core in as **linked source**, so the whole engine registers as one signed assembly with no `Core.dll` runtime dependency. A file added to Core is picked up automatically |
| `tests/Ascentix.RulesEngine.Tests/` | Engine unit tests (xunit + FakeXrmEasy) |
| `client/src/` | TypeScript: the client form library, the authoring forms, and the React Rule Builder (`client/src/editor/`) |
| `client/test/`, `client/test-dev/`, `client/e2e/` | The three verification layers (below) |
| `docs/` | `Schema.md`, `Security.md`, `Plugin-Registration.md`, the other engine reference docs, and the customer documentation under `docs/guide/` |
| `Solutions/` | A **generated** mirror of the exported Dataverse solution |
| `pipelines/` | The Azure Pipelines definitions that build, test and release the engine (below) |

## Building

Prerequisites: **.NET SDK 10.x** (the `.slnx` solution format needs 9.0.200+; CI installs 10.x)
and **Node 24**. Windows is the verified build host.

```
dotnet build ValidationEngine.slnx
```

The engine targets **.NET Framework 4.6.2** with **LangVersion 8.0**, which is what Dataverse
plug-in assemblies run on: C# 9+ syntax will not compile in Core. (The plug-in project itself is
set to LangVersion 10.0, but the code that matters is Core's.)

Dataverse requires plug-in assemblies to be strong-name signed. This repository commits a
**development key**, `Ascentix.RulesEngine.Plugin/Ascentix.Dev.snk`, and every ordinary build signs
with it: a clean clone builds and the whole test suite runs with no key of your own. That key is
public and signs nothing anyone should trust. Official release artifacts are signed with a
separate key that is not in this repository, which is why an official build and your build have
different assembly identities. The public half of the release key is published at
`Ascentix.RulesEngine.Plugin/Ascentix.Release.publickey` so anyone can verify an official
artifact (see "Verifying a release" in `README.md`).

To produce a build signed with your own key instead:

```
dotnet build /p:SigningKeyFile=<path to your .snk>
```

`Core`'s `InternalsVisibleTo` declaration names the development key, so a differently signed
build cannot also compile the test project. Build the plug-in project alone when signing with
your own key.

Client bundles:

```
cd client
npm ci
npm run build
```

That runs the docs and font-CSS generators and then esbuild, emitting the web-resource bundles
(`asx_rulesengine.js`, `asx_authoringforms.js`, `asx_ruleeditor.js`, `asx_editor.css`) into
`client/dist/`.

**Building is not releasing.** The shipped managed solution is exported from the maintainer's
Dataverse development environment by the maintainer's release build, which stamps the version,
unpacks the export into `Solutions/`, and produces the signed zip. You cannot produce a
supported release artifact from this source tree alone.

## Forking and redistribution

Apache-2.0 (see [LICENSE](LICENSE)) lets you fork this project and redistribute it, modified or
not. One practical hazard is easy to miss.

**Dataverse identifies a solution by its unique name, and a publisher by its prefix.** The
unpacked solution under `Solutions/` carries the official identity, the same identity already
installed in any environment that took the official release. A fork that packs and distributes
under that identity can import into such an environment as something the platform treats as an
*upgrade of the official solution*, and its choice columns can collide on generated option
values. Importing takes administrator rights in the target environment, so this is a footgun
rather than an attack.

If you intend to **distribute** your fork, rather than just run your own build in your own
environments, give it its own identity first. The four values that matter, as shipped:

| What | Shipped value | Element |
|---|---|---|
| Publisher unique name | `ascentix` | `SolutionManifest/Publisher/UniqueName` |
| Customization prefix | `asx` | `SolutionManifest/Publisher/CustomizationPrefix` |
| Option value prefix | `10000` | `SolutionManifest/Publisher/CustomizationOptionValuePrefix` |
| Solution unique name | `AscentixRulesEngine` | `SolutionManifest/UniqueName` |

They are visible in `Other/Solution.xml` under both
`Solutions/AscentixRulesEngine/AscentixRulesEngine_unmanaged/` and
`…_managed/`. Read them there, but do not change them there: `Solutions/` is a generated mirror
(see below), and the identity lives in the Dataverse environment the solution is exported from.
A fork creates its own publisher and its own solution in its own environment, and exports from
that.

**Changing the customization prefix is not a cheap rename.** Every table and column logical name
carries it (`asx_rule`, `asx_tableconfig`, `asx_conditiongroup`, `asx_rulecondition`,
`asx_ruleaction`, and the rest), and Dataverse does not let you change a logical name after the
component is created, so a new prefix means building the schema again under the new publisher.
The engine side is prepared for it: the fragments in
`Ascentix.RulesEngine.Core/Schema/SchemaNames.cs` are deliberately prefix-agnostic and
`SchemaNames.DefaultPrefix` is a single point of change. The client is not: `asx_` appears
literally around 600 times across `client/src`, with no constant behind it.

**Assembly identity.** Dataverse registers a plug-in assembly by its strong name, and the
development key in this repository is public, so a build made from a clean clone is not
distinguishable from anyone else's. Sign a build you intend to redistribute with **your own
key**, so your assembly is a distinct registration.

## Testing

Three layers, named L1 / L2 / L3 throughout the repo and the docs.

**The L1 hermetic unit tests** need no environment and no credentials. This is the layer an
outside contributor works in.

```
dotnet test tests/Ascentix.RulesEngine.Tests/Ascentix.RulesEngine.Tests.csproj

cd client
npm test          # vitest
npm run typecheck # tsc --noEmit over all three tsconfigs
```

`npm run typecheck` checks `tsconfig.json`, `tsconfig.test.json` **and** `tsconfig.e2e.json`. A
change can pass one and fail another, so run all three before pushing client changes.

**The L2 live contract suites** (`client/test-dev`, `npm run test:dev`) run against a real
Dataverse development environment over the Web API. **The L3 browser suites** (`client/e2e`,
`npm run test:e2e`, Playwright) drive the Rule Builder in a real environment, alongside a
signed manual checklist a human performs once per release.

L2 and L3 need credentials for a Dataverse environment the harness is allowed to create and sweep
fixtures in, so in practice the maintainer runs them. Do not point them at an environment you
care about: they create and remove fixture data as they go, and the two suites share one
environment, so running them at the same time makes both unreliable. If a change needs live
proof, say so in your pull request and the maintainer will run them.

Three further guards run over the client. Treat a failure in any of them as a failing test:

```
npm run check:skips      # every .skip must carry an annotation
npm run check:matrix     # coverage-matrix claims must match reality
npm run check:staleness  # reports how stale the recorded live runs are
```

A skipped test must be annotated on or just above the `.skip` line, or `check:skips` fails:

```
// SKIP(<reason>, <issue>, expires: YYYY-MM-DD)
```

Green full runs of `npm run test:dev` / `npm run test:e2e` record themselves locally, and
`check:staleness` reports how long ago that was. A checkout with no recorded run reports that
there is none.

## Continuous integration

The pipelines that build and test this project are in `pipelines/`, written for Azure Pipelines.
Two of them, `plugin-ci.yml` and `client-ci.yml`, are in two halves. The first half runs the
tests and needs nothing but the repository. The second half deploys to the maintainer's Dataverse
development environment and needs a `dataverse-dev` variable group, an `Azure-DataverseCI`
service connection, and, for the plug-in, the release signing key as a secure file.

To run these in your own Azure DevOps project, set the `deployToDev` parameter to `false` at the
top of the file:

```yaml
parameters:
  - name: deployToDev
    type: boolean
    default: false
```

That leaves you the test stages and drops every reference to the maintainer's environment. It has
to be a template parameter rather than a runtime `condition:`, because Azure Pipelines resolves a
secure file and a variable group when it validates the YAML, before any condition is read. A
pipeline that merely skips those stages at run time still fails to compile without them.

`client-live.yml`, `solution-release.yml` and `localization-deploy.yml` run the live suites,
export the shipped solution, and deploy to the localization org, all against the maintainer's
environments. There is nothing in them to run elsewhere.

None of this is needed to contribute. The build and the two offline test suites run from a clean
clone with no credentials at all, which is the same thing CI checks.

## The schema is contract-driven

**`Ascentix.RulesEngine.Core/Schema/SchemaNames.cs` and `docs/Schema.md` are the source
of truth for the data model**: the first is the set of logical names the engine binds to, and the
second is the human-readable specification. Solution XML is *not* the source of truth.

**`Solutions/` is generated, not authored.** The maintainer's release build exports the solution
from the development environment, unpacks it (managed and unmanaged), and commits the result
there as a history and diff mirror. It should not be hand-edited.

**Environment first.** Tables, columns, choices and lookups are created or modified *in the
Dataverse environment* using the Dataverse tooling, never by hand-editing solution XML to invent
components. After any schema change, update `docs/Schema.md` and `SchemaNames.cs` so the contract
matches the environment. A change that lands in only one of the three is a defect.

Product components use the `asx_` prefix and belong to the `AscentixRulesEngine`
solution. Fixture and sample schema (for example `sample_*`) must **never** be added to that
solution: doing so pulls a partial customer table into the shipping package, and the managed
import then fails on any organization that lacks the table. Fixture schema goes in no solution,
or in a throwaway one.

If a schema change adds or renames a **lookup** (a new `@odata.bind` navigation property) or a
column referenced by one of the `*_SELECT` constants, the live L2 contract suite is the only
place the `@odata.bind` casing contract in `client/src/editor/load/odata.ts` is checked against
real Dataverse. CI does not cover it. Flag such a change in your pull request, since that run
can only happen on the maintainer's environment.

## Definition of done for a fix that needs live proof

Some defects can only be shown against a real environment, and *merged is not deployed, and
deployed is not verified*. For those:

- The previously failing case is un-skipped and **green against the environment the fix was
  deployed to**, in a run made **after** that deploy.
- The run output is pasted into the pull request.
- `client/test-dev/ruleBehavior/COVERAGE-MATRIX.md` is updated to match.

Most contributors cannot run the live suites. Write the failing case, mark it clearly, and note
what evidence is still missing; the maintainer closes that loop.

## Conventions the code follows

- **Naming follows `CONTEXT.md`.** If a concept has a name there, use that name in types,
  methods, tests and messages.
- **Core is written to be testable without Dataverse.** The evaluation stage takes plain values
  and interfaces, not a live organization service; anything that needs the platform lives in the
  gather and dispatch stages. Keep new logic on the pure side of that seam where you can.
- **Fail loudly.** The engine deliberately throws a named error rather than evaluating against
  partial or empty data: an unfetched node, a broken lookup chain, a traversal over the row cap.
  The fix for one of these is usually upstream, in making sure the data is there, rather than in
  returning an empty collection.
- **Fail closed.** Where the engine decides whether a rule *can* be skipped, an incomplete answer
  must err toward evaluating the rule, not skipping it.
- Core is `Nullable=disable`, `ImplicitUsings=disable`. Match the file you are editing.
- XML doc comments on public engine types, especially where the comment records *why* a decision
  was made. Keep the existing ones rather than deleting them.
- Tests are xunit, one file per subject, named for the behaviour under test.
- Client code is TypeScript with React 18 and Fluent UI. Everything in `dependencies` gets
  bundled into a web resource and shipped inside the customer's environment, so raise a new
  runtime dependency in an issue before you build on it.

## Changes to documentation

`docs/guide/` is the product documentation. It is the source for both the published site and the
in-app help viewer, so it is compiled into the solution as well as mirrored. If a change alters
behaviour that a page describes, update the page in the same pull request. `CHANGELOG.md` is
written by the maintainer at release time from the pull request description, so you do not need
to touch it.

## Pull requests

Keep them focused, explain *why* in the description, and fill in the template. Pre-flight:

- `dotnet test …` is green.
- `npm test` and `npm run typecheck` are green if you touched `client/`.
- New or changed behaviour has a test.
- Documentation that describes the behaviour you changed has been updated.
- No credentials, environment URLs, tokens, or customer data anywhere in the diff.
