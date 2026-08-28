import { describe, it, expect } from "vitest";
import { renderWithFluent } from "./domFixtures";
import { InspectorShell } from "../../src/editor/ui/InspectorShell";

describe("InspectorShell overlay width", () => {
  it("caps the drawer width to the viewport", () => {
    renderWithFluent(
      <InspectorShell mode="overlay" open header={{ eyebrow: "E", title: "T" }} onClose={() => {}}>
        <div>b</div>
      </InspectorShell>,
    );
    const surface = document.querySelector<HTMLElement>(".fui-OverlayDrawer");
    expect(surface).not.toBeNull();
    expect(surface!.style.width).toBe("330px");
    expect(surface!.style.maxWidth).toBe("92vw");
  });
});
