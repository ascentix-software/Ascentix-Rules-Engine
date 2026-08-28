import { describe, it, expect } from "vitest";
import {
  emptyBlock, emptyLeaf, emptyExists, emptyGroup, isFilterEmpty, isBlockEmpty, isExistsComplete,
} from "../../src/editor/model/nodeFilter";

describe("nodeFilter model", () => {
  it("a fresh block with one blank leaf and no target is empty", () => {
    const block = emptyBlock();
    expect(isBlockEmpty(block)).toBe(true);
    expect(isFilterEmpty([block])).toBe(true);
  });

  it("a block with a complete leaf and a target node is not empty", () => {
    const block = emptyBlock("node-1");
    (block.root.rules[0] as ReturnType<typeof emptyLeaf>).column = "amount";
    (block.root.rules[0] as ReturnType<typeof emptyLeaf>).operator = 3;
    (block.root.rules[0] as ReturnType<typeof emptyLeaf>).value = "100";
    expect(isBlockEmpty(block)).toBe(false);
    expect(isFilterEmpty([block])).toBe(false);
  });

  it("a complete leaf without a target node still leaves the block empty (target is per-block)", () => {
    const block = emptyBlock(null);
    (block.root.rules[0] as ReturnType<typeof emptyLeaf>).column = "amount";
    (block.root.rules[0] as ReturnType<typeof emptyLeaf>).operator = 3;
    (block.root.rules[0] as ReturnType<typeof emptyLeaf>).value = "100";
    expect(isBlockEmpty(block)).toBe(true);
  });

  it("isFilterEmpty is true only when EVERY block is empty", () => {
    const empty = emptyBlock();
    const full = emptyBlock("node-1");
    (full.root.rules[0] as ReturnType<typeof emptyLeaf>).column = "amount";
    (full.root.rules[0] as ReturnType<typeof emptyLeaf>).operator = 3;
    (full.root.rules[0] as ReturnType<typeof emptyLeaf>).value = "100";
    expect(isFilterEmpty([empty, full])).toBe(false);
    expect(isFilterEmpty([empty])).toBe(true);
    expect(isFilterEmpty([])).toBe(true);
  });

  it("emptyExists() produces a blank exists node with an empty sub-group", () => {
    const node = emptyExists();
    expect(node.kind).toBe("exists");
    expect(typeof node.id).toBe("string");
    expect(node.id.length).toBeGreaterThan(0);
    expect(node.collectionNodeId).toBeNull();
    expect(node.minCount).toBe(1);
    expect(node.maxCount).toBeNull();
    // sub is a fresh empty group (structurally, ignoring the auto-generated temp ids which
    // differ per call to newTempId()).
    const blank = emptyGroup();
    expect(node.sub.kind).toBe(blank.kind);
    expect(node.sub.op).toBe(blank.op);
    expect(node.sub.rules).toHaveLength(1);
    expect(node.sub.rules[0].kind).toBe("rule");
  });

  it("isExistsComplete is false with no collection and true once a collection is set", () => {
    const node = emptyExists();
    expect(isExistsComplete(node)).toBe(false);
    node.collectionNodeId = "node-2";
    expect(isExistsComplete(node)).toBe(true);
  });

  it("a block whose root contains only an incomplete exists node is empty", () => {
    const block = emptyBlock("node-1");
    block.root.rules = [emptyExists()];
    expect(isBlockEmpty(block)).toBe(true);
    expect(isFilterEmpty([block])).toBe(true);
  });

  it("a block whose root contains a complete exists node (collection set) is not empty", () => {
    const block = emptyBlock("node-1");
    const exists = emptyExists();
    exists.collectionNodeId = "node-2";
    block.root.rules = [exists];
    expect(isBlockEmpty(block)).toBe(false);
    expect(isFilterEmpty([block])).toBe(false);
  });
});
