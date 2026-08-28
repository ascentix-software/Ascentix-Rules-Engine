import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent, makeGraph } from "./domFixtures";

describe("dom test infrastructure", () => {
  it("renders into jsdom and jest-dom matchers work", () => {
    renderWithFluent(<button>hello</button>);
    expect(screen.getByRole("button", { name: "hello" })).toBeInTheDocument();
  });

  it("fixtures build a valid graph", () => {
    expect(makeGraph().rule.tableLogicalName).toBe("account");
  });
});
