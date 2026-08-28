import { describe, it, expect, vi, beforeAll } from "vitest";
import { waitFor } from "@testing-library/dom";

// Boot containment: importing the editor entry with no Xrm anywhere (the
// documented standalone raw-URL scenario, Rule-Editor.md §3) must render the
// degradation panel, never a blank page, never an uncaught throw.
//
// One import, one file: the entry module boots on import, so this suite owns it.

describe("editor boot without Xrm", () => {
  // The import pulls the ENTIRE editor module graph through the transform pipeline, by far
  // the heaviest single import in the suite. Under full-suite fork contention its cold cost
  // blows past the global hook timeout (observed on CI), so this hook gets its own
  // generous budget; the assertions below still run under the normal test timeout.
  beforeAll(async () => {
    document.body.innerHTML = '<div id="root"></div>';
    delete (window as any).Xrm;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../src/editor/index");
  }, 60000);

  it("renders the degradation panel with the Xrm message, the in-app hint, and Reload", async () => {
    await waitFor(() => {
      const panel = document.querySelector('[data-testid="error-panel"]');
      expect(panel).not.toBeNull();
      expect(panel!.textContent).toContain("The editor could not start.");
      expect(panel!.textContent).toContain("Xrm.WebApi is not available in this context.");
      expect(panel!.textContent).toContain("must be opened from within a model-driven app");
      expect(panel!.querySelector("button")).not.toBeNull();
      expect(panel!.textContent).not.toContain("[object Object]");
    });
  });
});
