// Display-only fallback when a localized choice label is unavailable.
export function humanize(token: string): string {
  if (!token) return "";
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}
