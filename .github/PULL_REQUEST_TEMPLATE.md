# What changed

<!-- One or two sentences. Use the vocabulary in CONTEXT.md. -->

# Why

<!-- The problem this solves. Link the issue if there is one. Anything substantial should have
     been discussed in an issue first. See CONTRIBUTING.md. -->

Closes #

# How it was tested

<!-- Which suites you ran and what they said. If a fix needs live proof and you cannot run the
     live suites, say so explicitly and name the evidence that is still missing. -->

# Checklist

- [ ] `dotnet test tests/Ascentix.RulesEngine.Tests/Ascentix.RulesEngine.Tests.csproj` is green
- [ ] `npm test` and `npm run typecheck` are green (client changes; typecheck covers all three tsconfigs)
- [ ] New or changed behaviour has a test
- [ ] Any skipped test carries a `// SKIP(<reason>, <issue>, expires: YYYY-MM-DD)` annotation
- [ ] Documentation updated if behaviour changed: `docs/guide/**` for customer-visible behaviour, `docs/Schema.md` + `Ascentix.RulesEngine.Core/Schema/SchemaNames.cs` for any schema change
- [ ] `Solutions/` not hand-edited
- [ ] No credentials, tokens, environment URLs, or customer data in the diff

## Live verification (only if this fix needs proof against a real environment)

- [ ] The previously failing case is un-skipped and green against the environment the fix was deployed to, in a run made **after** the deploy
- [ ] Run output pasted below
- [ ] `client/test-dev/ruleBehavior/COVERAGE-MATRIX.md` updated

<!-- paste run output here -->
