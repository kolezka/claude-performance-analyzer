// Page routing lives in the URL hash (#/hooks?name=...), so ?host= in the search stays owned by host selection.
export const PAGES = ["overview", "turns", "hooks", "tools", "models", "errors", "hosts", "settings"] as const;
export type Page = (typeof PAGES)[number];
export type Route = { page: Page; params: Record<string, string> };

export const PAGE_TITLES: Record<Page, string> = {
  overview: "Overview",
  turns: "Turns",
  hooks: "Hooks",
  tools: "Tools & MCP",
  models: "Models",
  errors: "Errors",
  hosts: "Remote hosts",
  settings: "Telemetry settings",
};

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const name = (q === -1 ? raw : raw.slice(0, q)).replace(/\/+$/, "");
  const params = Object.fromEntries(new URLSearchParams(q === -1 ? "" : raw.slice(q + 1)));
  const page = (PAGES as readonly string[]).includes(name) ? (name as Page) : "overview";
  return { page, params };
}

export function routeHash(page: Page, params: Record<string, string | number | undefined | null> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `#/${page}${s ? `?${s}` : ""}`;
}
