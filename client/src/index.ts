import { onLoad } from "./engine";

// Expose the form-registered entry point under a stable global namespace.
// The form's OnLoad handler references `Ascentix.RulesEngine.onLoad`.
const g = globalThis as unknown as { Ascentix?: { RulesEngine?: { onLoad: typeof onLoad } } };
g.Ascentix = g.Ascentix || {};
g.Ascentix.RulesEngine = { onLoad };

export { onLoad };
