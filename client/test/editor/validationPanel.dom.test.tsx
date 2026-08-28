import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { ValidationIssuesPanel } from "../../src/editor/ui/ValidationIssuesPanel";
import type { ApiIssue } from "../../src/editor/webapi";

describe("ValidationIssuesPanel", () => {
  it("is always present as a status live region, even with no issues", () => {
    renderWithFluent(<ValidationIssuesPanel issues={[]} />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
  });

  it("renders issue message text inside the status region", () => {
    const issues: ApiIssue[] = [
      {
        severity: "Error",
        code: "REQ001",
        message: "Field is required.",
        target: { kind: "condition", id: "c1", field: "name" },
      },
    ];
    renderWithFluent(<ValidationIssuesPanel issues={issues} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Field is required.");
  });
});
