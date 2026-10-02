import { expect, test } from "bun:test";
import { BoundedCache } from "../src/bounded-cache";

test("BoundedCache evicts the oldest entry once past its size cap", () => {
  const cache = new BoundedCache<number>(3, 60_000);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.set("d", 4); // over the cap of 3, so "a" (oldest) is evicted
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBe(2);
  expect(cache.get("d")).toBe(4);
  expect(cache.size).toBe(3);
});

test("BoundedCache expires an entry after its TTL", () => {
  const cache = new BoundedCache<number>(10, 1000);
  cache.set("a", 1, 0);
  expect(cache.get("a", 500)).toBe(1);
  expect(cache.get("a", 1500)).toBeUndefined();
});
