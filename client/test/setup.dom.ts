import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { configure } from "@testing-library/react";

// Heavy editor DOM tests mount Fluent Dialogs + async metadata fetches. Under the full-suite
// parallel worker load, CPU contention can push a render/settle past the default 1000ms findBy
// window, flaking assertions that pass comfortably in isolation. Give all DOM async queries a
// generous, uniform timeout here (was previously patched per-file, which starved as suite load grew).
if (typeof window !== "undefined") {
  configure({
    asyncUtilTimeout: 10000,

    // Don't let *ByRole filter on the accessibility tree: under jsdom, aria-hidden is not
    // trustworthy around Fluent modals.
    //
    // Fluent focuses the DialogSurface programmatically when a modal opens, and tabster only
    // marks the modalizer active (setActive) when it observes that focus as programmatic. When a
    // test awaits a query before the click that opens the dialog (as every openDialog()-style
    // helper here does), that ordering shifts, the modalizer is never activated, and tabster's
    // deferred hiddenUpdate() timer (tabster/Modalizer, setTimeout 250ms) then files the *modal
    // itself* under `hiddenElements`, stamping aria-hidden="true" on the DialogSurface (and
    // un-hiding the background, the inverse of correct modal behaviour). Dialog content then
    // becomes permanently unqueryable by role: a synchronous query beats the 250ms timer, an
    // awaited one loses on a slow CI agent, and no findBy timeout can ever recover it. That
    // asymmetry is why this looked like a timeout problem and swallowed three "wait longer"
    // fixes that could only ever make it worse.
    //
    // This is a jsdom artifact, not a product bug: real browsers have layout and focus lands on a
    // real control, so the modalizer activates and the background (not the dialog) gets hidden.
    // Trade-off: *ByRole will no longer skip genuinely aria-hidden nodes, so it can't catch that
    // class of a11y regression. Guarded by test/editor/dialogA11yQueryable.dom.test.tsx.
    defaultHidden: true,
  });
}

// This project runs Vitest without `globals: true`, so Testing Library's
// auto-cleanup (which only registers when it detects a global `afterEach`)
// never activates. Register it explicitly for DOM tests so rendered output
// from one `it` block cannot leak into the next. Guarded + lazily imported
// so the node logic suite (no DOM) is unaffected.
if (typeof window !== "undefined") {
  afterEach(async () => {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
    window.sessionStorage.clear();
  });
}

// setupFiles run in every environment; guard DOM-only globals so the
// node logic suite is unaffected.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
