using System.Runtime.CompilerServices;

// The engine's reference-extraction helpers (FieldMappingReferences, MathExpr.*Refs,
// TemplateRenderer.Tokenize/NodeReferences, DateExprSpec.Parse) are implementation details
// behind RuleReferences; the per-kind truth-table tests still pin them.
//
// Core is compiled into the strong-named plug-in assembly, and a strong-named assembly can
// only grant friend access to an assembly identified by public key. The key named here is
// the DEVELOPMENT key (Ascentix.Dev.snk), which is committed to this repository and which
// every ordinary build signs with -- so the test assembly is admitted on a normal checkout
// with no key of your own.
//
// Official release artifacts are signed with a different, unpublished key. That does not
// affect this declaration: it names the friend's key, not the granting assembly's, so a
// release build compiles unchanged. See Directory.Build.props.
[assembly: InternalsVisibleTo("Ascentix.RulesEngine.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100114a1382116c6a9664fb371cb0e7e124adec907780010818f9ba38734ae09a532d985bdbb002588146968ff24c81943e" +
    "fc37c60729815c6743316bcc9dd3ed53fbf8702fbc3eab32d5c88fa6d5d5b600077b9d12376d2ba70e488b7fb1e06da24a189e495698427c124124c4d43af604c031f857bab9f370f45d13c896a931b5")]
