import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { formatError, isPrivilegeDeniedError, ErrorBoundary, ErrorPanel } from "../../src/editor/ui/errors";

// The normalizer + shared boundary/panel. The banned output is "[object Object]",
// the exact string every raw Xrm.WebApi rejection produced under String(e).

describe("formatError", () => {
  it("passes strings and Error messages through", () => {
    expect(formatError("boom")).toBe("boom");
    expect(formatError(new Error("kaput"))).toBe("kaput");
  });

  it("unwraps Xrm-style rejection objects", () => {
    expect(formatError({ message: "0x80040217 not found" })).toBe("0x80040217 not found");
    expect(formatError({ error: { message: "nested odata message" } })).toBe("nested odata message");
    expect(formatError({ errorCode: 2147745537, message: "privilege denied" })).toBe("privilege denied");
  });

  it("never yields [object Object] for any shape", () => {
    const shapes: unknown[] = [
      {}, { code: 42 }, { deeply: { nested: true } }, [1, 2], null, undefined, 7,
      Object.create(null),
    ];
    for (const s of shapes) {
      expect(formatError(s)).not.toContain("[object Object]");
      expect(formatError(s).length).toBeGreaterThan(0);
    }
    // circular object: JSON.stringify throws, still no [object Object]
    const circular: any = {}; circular.self = circular;
    expect(formatError(circular)).not.toContain("[object Object]");
  });

  it("truncates giant JSON payloads", () => {
    const huge = { data: "x".repeat(5000) };
    expect(formatError(huge).length).toBeLessThan(500);
  });
});

describe("isPrivilegeDeniedError", () => {
  it("is true for an HTTP 403, however it's carried", () => {
    expect(isPrivilegeDeniedError({ httpStatus: 403 })).toBe(true);
    expect(isPrivilegeDeniedError({ status: 403 })).toBe(true);
  });

  it("is true for an Xrm.WebApi missing-privilege message, which carries no status", () => {
    expect(isPrivilegeDeniedError(new Error("Principal user is missing prvReadasx_RuleSchedule privilege"))).toBe(true);
    expect(isPrivilegeDeniedError({ error: { message: "missing the asx_ruleschedule Read privilege" } })).toBe(true);
  });

  it("is false for a plain failure: network error, 500, or any message without the word privilege", () => {
    expect(isPrivilegeDeniedError(new Error("Network request failed"))).toBe(false);
    expect(isPrivilegeDeniedError({ httpStatus: 500 })).toBe(false);
    expect(isPrivilegeDeniedError(new Error("timeout"))).toBe(false);
    expect(isPrivilegeDeniedError(null)).toBe(false);
    expect(isPrivilegeDeniedError(undefined)).toBe(false);
  });
});

describe("ErrorBoundary + ErrorPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  function Bomb(): never {
    throw new Error("render exploded");
  }

  it("contains a render throw and offers Reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the caught throw
    render(
      <ErrorBoundary area="rule editor">
        <Bomb />
      </ErrorBoundary>,
    );
    const panel = screen.getByTestId("error-panel");
    expect(panel).toHaveTextContent("The rule editor hit an unexpected error.");
    expect(panel).toHaveTextContent("render exploded");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <ErrorBoundary area="hub">
        <div data-testid="content">fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(screen.queryByTestId("error-panel")).toBeNull();
  });

  it("panel normalizes object errors and survives a Reload click in jsdom", () => {
    render(<ErrorPanel title="The hub could not load." error={{ message: "0x80040265 custom fault" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("0x80040265 custom fault");
    expect(screen.getByRole("alert")).not.toHaveTextContent("[object Object]");
    fireEvent.click(screen.getByRole("button", { name: "Reload" })); // must not throw
  });
});
