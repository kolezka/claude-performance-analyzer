// Detail fetches for a page. A change of scope (host, window, selected item) invalidates every
// request of the old scope first, so a late answer for host A never lands while B is shown.
import { RequestGate } from "../hosts";

type FetchFn = typeof fetch;

export class PageLoader {
  private gate = new RequestGate();
  private scope: string | null = null;

  constructor(private fetchFn: FetchFn = (...args) => fetch(...args)) {}

  // Returns false when the answer went stale. Errors go to fail with the HTTP status (null = no answer).
  load<T>(scope: string, url: string, ok: (value: T) => void, fail?: (error: string, status: number | null) => void): Promise<boolean> {
    if (scope !== this.scope) {
      this.gate.invalidate();
      this.scope = scope;
    }
    return this.gate.run<T>(this.fetchFn, url, { ok, fail });
  }

  dispose(): void {
    this.gate.invalidate();
    this.scope = null;
  }
}
