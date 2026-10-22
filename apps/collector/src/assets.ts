// The dashboard HTML and its generated assets live on a private loopback server, so Bun still
// bundles them, while the public listener keeps one gated fetch handler and no static routes.
import dashboard from "@cpa/dashboard/index.html";

export function startDashboardServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/": dashboard },
    fetch: () => new Response("Not Found", { status: 404 }),
    development: process.env.NODE_ENV !== "production" ? { hmr: false, console: true } : false,
  });
}

const PASSED_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];

// Runs only after the gate. Forwards path and query, never the caller's Host or Authorization.
export function proxyAssets(origin: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method === "HEAD" ? "HEAD" : "GET";
    const res = await fetch(`${origin}${url.pathname}${url.search}`, { method, redirect: "manual" });
    const headers = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(method === "HEAD" ? null : await res.arrayBuffer(), { status: res.status, headers });
  };
}
