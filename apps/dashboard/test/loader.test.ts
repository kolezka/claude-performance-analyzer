import { expect, test } from "bun:test";
import { PageLoader } from "../src/pages/loader";

function deferredFetch() {
  const calls: { url: string; body: (v: unknown) => void }[] = [];
  const fetchFn = ((url: string) => {
    let body!: (v: unknown) => void;
    const p = new Promise((r) => (body = r));
    calls.push({ url: String(url), body });
    return Promise.resolve({ ok: true, status: 200, statusText: "", json: () => p });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("an answer for the old scope does not land after the scope changes", async () => {
  const net = deferredFetch();
  const loader = new PageLoader(net.fetchFn);
  let got: unknown = null;
  loader.load("host-A", "/api/turns?host=A", (v) => (got = v));
  loader.load("host-B", "/api/turns?host=B", (v) => (got = v));
  net.calls[0]!.body("A");
  await flush();
  expect(got).toBeNull();
  net.calls[1]!.body("B");
  await flush();
  expect(got).toBe("B");
});

test("A to B to A: the first A request stays stale", async () => {
  const net = deferredFetch();
  const loader = new PageLoader(net.fetchFn);
  const got: unknown[] = [];
  loader.load("A", "/a1", (v) => got.push(v));
  loader.load("B", "/b", (v) => got.push(v));
  loader.load("A", "/a2", (v) => got.push(v));
  net.calls[0]!.body("old A");
  net.calls[1]!.body("B");
  net.calls[2]!.body("new A");
  await flush();
  expect(got).toEqual(["new A"]);
});

test("requests in the same scope all land", async () => {
  const net = deferredFetch();
  const loader = new PageLoader(net.fetchFn);
  const got: unknown[] = [];
  loader.load("A", "/x", (v) => got.push(v));
  loader.load("A", "/y", (v) => got.push(v));
  net.calls[0]!.body(1);
  net.calls[1]!.body(2);
  await flush();
  expect(got).toEqual([1, 2]);
});

test("dispose drops everything in flight", async () => {
  const net = deferredFetch();
  const loader = new PageLoader(net.fetchFn);
  let got: unknown = null;
  loader.load("A", "/x", (v) => (got = v));
  loader.dispose();
  net.calls[0]!.body(1);
  await flush();
  expect(got).toBeNull();
});
