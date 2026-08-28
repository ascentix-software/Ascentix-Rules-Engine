import { describe, it, expect, beforeEach } from "vitest";
import { newTempId, isNewId, resetTempIds } from "../../src/editor/model/ids";

describe("temp ids", () => {
  beforeEach(() => resetTempIds());

  it("generates monotonic temp ids", () => {
    expect(newTempId()).toBe("new-1");
    expect(newTempId()).toBe("new-2");
  });
  it("recognizes temp vs real ids", () => {
    expect(isNewId("new-1")).toBe(true);
    expect(isNewId("11111111-1111-1111-1111-111111111111")).toBe(false);
  });
});
