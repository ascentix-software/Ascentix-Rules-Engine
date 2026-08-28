import { describe, it, expect } from "vitest";
import { createDevApi } from "./devApi";

describe("DEV connectivity", () => {
  it("reaches DEV and returns a user id from WhoAmI", async () => {
    const api = createDevApi();
    const who = await api.fetchJson("WhoAmI");
    expect(who.UserId).toMatch(/[0-9a-f-]{36}/i);
  });
});
