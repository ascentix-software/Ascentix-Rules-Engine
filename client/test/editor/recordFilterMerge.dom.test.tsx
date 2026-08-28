import { describe, it, expect } from "vitest";
import { mergeFilterIntoFetchXml, withPaging } from "../../src/editor/ui/pickers/recordFilter";

const view = `<fetch><entity name="account"><attribute name="name" />` +
  `<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter>` +
  `<order attribute="name" /></entity></fetch>`;

describe("mergeFilterIntoFetchXml", () => {
  it("wraps the view filter and the user filter under a top-level AND", () => {
    const userFilter = `<filter type="or"><condition attribute="name" operator="like" value="%a%" /></filter>`;
    const out = mergeFilterIntoFetchXml(view, userFilter, null);
    const doc = new DOMParser().parseFromString(out, "text/xml");
    const top = doc.querySelector("entity > filter");
    expect(top?.getAttribute("type")).toBe("and");
    // original view filter preserved as a child, user filter added as a child
    expect(out).toContain(`<condition attribute="statecode" operator="eq" value="0"`);
    expect(out).toContain(`<filter type="or">`);
    expect(out).toContain(`operator="like" value="%a%"`);
  });
  it("adds a text-search contains condition when provided", () => {
    const out = mergeFilterIntoFetchXml(view, "", { attribute: "name", term: "ac'me" });
    expect(out).toContain(`<condition attribute="name" operator="like" value="%ac'me%"`);
  });
  it("escapes XML metacharacters in the text-search term so the merge stays valid", () => {
    const out = mergeFilterIntoFetchXml(view, "", { attribute: "name", term: "Q&A" });
    const doc = new DOMParser().parseFromString(out, "text/xml");
    // an unescaped & would make the reparsed wrapper a <parsererror> and drop the view filter
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(out).toContain(`operator="eq" value="0"`);
    expect(out).toContain(`%Q&amp;A%`);
  });
  it("no user filter and no text search leaves the query runnable and unchanged in shape", () => {
    const out = mergeFilterIntoFetchXml(view, "", null);
    expect(out).toContain(`<entity name="account"`);
    expect(out).toContain(`operator="eq" value="0"`);
  });
});

describe("withPaging", () => {
  it("sets page and count on the fetch element", () => {
    const out = withPaging(view, 2, 50);
    const fetch = new DOMParser().parseFromString(out, "text/xml").querySelector("fetch")!;
    expect(fetch.getAttribute("page")).toBe("2");
    expect(fetch.getAttribute("count")).toBe("50");
  });
});
