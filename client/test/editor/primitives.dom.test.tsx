import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { Eyebrow, Pill, Callout, Field, StatusBadge, statusTone, UnsavedPill } from "../../src/editor/ui/primitives";
import { contrastRatio } from "../../src/editor/ui/tokens";

describe("Eyebrow", () => {
  it("renders its text", () => {
    renderWithFluent(<Eyebrow>Rule name</Eyebrow>);
    expect(screen.getByText("Rule name")).toBeInTheDocument();
  });

  it("defaults to the AA-safe muted ink, never the retired grey", () => {
    renderWithFluent(<Eyebrow>Label</Eyebrow>);
    const el = screen.getByText("Label");
    expect(el.style.color).toBe("rgb(86, 91, 107)"); // color.inkMuted
  });

  it("uses brand ink for the brand variant", () => {
    renderWithFluent(<Eyebrow variant="brand">Label</Eyebrow>);
    expect(screen.getByText("Label").style.color).toBe("rgb(74, 68, 201)"); // color.brandInk
  });
});

describe("Pill", () => {
  it("renders a text label for every tone (WCAG 1.4.1 — never color alone)", () => {
    renderWithFluent(<Pill tone="published">Published</Pill>);
    expect(screen.getByText("Published")).toBeInTheDocument();
  });

  it("pairs the warn tone as warnInk-on-warnTint, never white-on-warn", () => {
    // color.warn is 3.38:1 on warnTint and 3.64:1 under white, fill only.
    renderWithFluent(<Pill tone="warn">Draft</Pill>);
    const el = screen.getByText("Draft");
    expect(el.style.color).toBe("rgb(138, 90, 0)");            // color.warnInk
    expect(el.style.backgroundColor).toBe("rgb(253, 246, 227)"); // color.warnTint
  });

  it.each([
    ["draft"], ["published"], ["archived"],
    ["danger"], ["warn"], ["info"], ["write"], ["neutral"], ["collection"],
  ] as const)("tone %s clears 4.5:1", (tone) => {
    renderWithFluent(<Pill tone={tone}>{tone}</Pill>);
    const el = screen.getByText(tone);
    const toHex = (rgb: string) => {
      const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
      return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    };
    expect(contrastRatio(toHex(el.style.color), toHex(el.style.backgroundColor)))
      .toBeGreaterThanOrEqual(4.5);
  });
});

describe("Callout", () => {
  it("renders title and body", () => {
    renderWithFluent(<Callout intent="info" title="Heads up">Body text</Callout>);
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("Body text")).toBeInTheDocument();
  });

  // WCAG 4.1.3: one Callout is the single place this guarantee lives.
  it.each([["warning"], ["danger"]] as const)("announces %s as an alert", (intent) => {
    renderWithFluent(<Callout intent={intent}>Something broke</Callout>);
    expect(screen.getByRole("alert")).toHaveTextContent("Something broke");
  });

  it.each([["info"], ["success"]] as const)("does NOT announce %s as an alert", (intent) => {
    renderWithFluent(<Callout intent={intent}>Just context</Callout>);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Field", () => {
  it("renders label and children", () => {
    renderWithFluent(<Field label="Name"><input aria-label="Name" /></Field>);
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("marks required with a danger asterisk", () => {
    renderWithFluent(<Field label="Name" required><input aria-label="Name" /></Field>);
    const star = screen.getByText("*");
    expect(star.style.color).toBe("rgb(200, 55, 45)"); // color.danger
  });

  it("renders a hint when given", () => {
    renderWithFluent(<Field label="Name" hint="Shown to users"><input aria-label="Name" /></Field>);
    expect(screen.getByText("Shown to users")).toBeInTheDocument();
  });
});

describe("statusTone", () => {
  it("maps the status option-set codes to Pill tones", () => {
    expect(statusTone(753840000)).toBe("published");
    expect(statusTone(2)).toBe("archived");
    expect(statusTone(1)).toBe("draft");
    expect(statusTone(null)).toBe("draft");   // unknown/unset → draft
  });
});

describe("UnsavedPill", () => {
  it("renders the warn Pill with an aria-hidden pulsing dot", () => {
    renderWithFluent(<UnsavedPill />);
    const label = screen.getByText("Unsaved changes");
    expect(label.style.backgroundColor).toBe("rgb(253, 246, 227)"); // warnTint
    const dot = label.querySelector("[aria-hidden]");
    expect(dot).not.toBeNull();
  });
});

describe("StatusBadge", () => {
  it("renders the status label as a Pill", () => {
    renderWithFluent(<StatusBadge statusCode={753840000} />);
    // statusReasonLabel(753840000) is the published label; assert it renders.
    const el = screen.getByText(/publish/i);
    expect(el).toBeInTheDocument();
    // published tone = success on successTint (from Task A); prove it's the Pill, not the old badge.
    expect(el.style.backgroundColor).toBe("rgb(236, 247, 240)");  // color.successTint #ecf7f0
  });
});
