import { describe, it, expect } from "vitest";
import { relativeTime, pageWindow, envHost, shortDate } from "../../src/editor/ui/hubFormat";

const NOW = Date.parse("2026-06-24T12:00:00Z");

describe("relativeTime", () => {
  it("returns — for null or unparseable", () => {
    expect(relativeTime(null, NOW)).toBe("—");
    expect(relativeTime("not-a-date", NOW)).toBe("—");
  });
  it("buckets recent times", () => {
    expect(relativeTime("2026-06-24T11:59:30Z", NOW)).toBe("just now");
    expect(relativeTime("2026-06-24T11:30:00Z", NOW)).toBe("30m ago");
    expect(relativeTime("2026-06-24T09:00:00Z", NOW)).toBe("3h ago");
    expect(relativeTime("2026-06-22T12:00:00Z", NOW)).toBe("2d ago");
  });
});

describe("pageWindow", () => {
  it("returns every page when 7 or fewer", () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(1, 1)).toEqual([1]);
  });
  it("windows with ellipses for many pages", () => {
    expect(pageWindow(1, 12)).toEqual([1, 2, "…", 12]);
    expect(pageWindow(6, 12)).toEqual([1, "…", 5, 6, 7, "…", 12]);
    expect(pageWindow(12, 12)).toEqual([1, "…", 11, 12]);
  });
});

describe("envHost", () => {
  it("returns the host of a URL, or the text when it isn't one", () => {
    expect(envHost("https://contoso-dev.crm.dynamics.com/")).toBe("contoso-dev.crm.dynamics.com");
    expect(envHost("https://contoso.crm4.dynamics.com/main.aspx?appid=1")).toBe("contoso.crm4.dynamics.com");
    expect(envHost("contoso-dev")).toBe("contoso-dev");
  });
});

describe("shortDate", () => {
  it("formats a date, and — for null or unparseable", () => {
    expect(shortDate("2026-10-14T12:00:00Z")).toBe(
      new Date("2026-10-14T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
    expect(shortDate(null)).toBe("—");
    expect(shortDate("not-a-date")).toBe("—");
  });
});
