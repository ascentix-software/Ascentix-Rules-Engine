import * as React from "react";

/** True when the viewport is at least `minWidth` px wide. Defaults to true when matchMedia is unavailable. */
export function useIsWide(minWidth = 1000): boolean {
  const query = `(min-width: ${minWidth}px)`;
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : true;
  const [wide, setWide] = React.useState(read);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setWide(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return wide;
}
