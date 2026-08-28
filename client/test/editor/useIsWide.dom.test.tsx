import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsWide } from "../../src/editor/ui/useIsWide";

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("useIsWide", () => {
  it("returns false when the viewport is below the breakpoint", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useIsWide(1000));
    expect(result.current).toBe(false);
  });

  it("returns true when the viewport is at/above the breakpoint", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useIsWide(1000));
    expect(result.current).toBe(true);
  });
});
