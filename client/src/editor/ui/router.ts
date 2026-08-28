// View router for the single editor web resource. Pure resolution of the query
// string (Dataverse passes record context as query params), so it is unit-testable
// with no Xrm/DOM access. Navigation is full-reload via window.location.search;
// keeping it here means a later switch to SPA-style routing touches only navigate().

export type View = "hub" | "rule" | "tableconfig" | "help";
export interface Route { view: View; id: string | null; }

const VIEWS: readonly View[] = ["hub", "rule", "tableconfig", "help"];

function cleanId(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.replace(/[{}]/g, "").trim();
  return v.length ? v : null;
}

export function resolveRoute(search: string): Route {
  const p = new URLSearchParams(search);
  const id = cleanId(p.get("id") ?? p.get("data"));

  const view = p.get("view");
  if (view && (VIEWS as readonly string[]).includes(view)) {
    return { view: view as View, id: view === "hub" || view === "help" ? null : id };
  }

  const typename = (p.get("typename") ?? p.get("entityname") ?? "").toLowerCase();
  if (typename === "asx_rule") return { view: "rule", id };
  if (typename === "asx_tableconfig") return { view: "tableconfig", id };

  return { view: "hub", id: null };
}

export function viewHref(view: View, idOrPage?: string | null): string {
  // hub never carries an id; editor views without an id fall back to the bare ?view=
  if (view === "hub" || !idOrPage) return `?view=${view}`;
  // help pages are addressed by ?page=, not ?id=
  const key = view === "help" ? "page" : "id";
  return `?view=${view}&${key}=${encodeURIComponent(idOrPage)}`;
}

export function navigate(view: View, idOrPage?: string | null): void {
  window.location.search = viewHref(view, idOrPage);
}
