import { expect, test } from "bun:test";
import { compact, pct, usd } from "../src/format";

test("usd shows <$0.01 for small positive amounts", () => {
  expect(usd(0.005)).toBe("<$0.01");
});

test("usd shows $0.00 at the zero boundary, not <$0.01", () => {
  expect(usd(0)).toBe("$0.00");
});

test("usd shows $0.01 at the lower-bound boundary, not <$0.01", () => {
  expect(usd(0.01)).toBe("$0.01");
});

test("usd formats normal amounts to two decimals", () => {
  expect(usd(1.234)).toBe("$1.23");
});

test("pct formats a ratio as a rounded percentage", () => {
  expect(pct(0.5)).toBe("50%");
  expect(pct(1)).toBe("100%");
  expect(pct(0.004)).toBe("0%");
});

test("compact formats counts with k/M suffixes", () => {
  expect(compact(999)).toBe("999");
  expect(compact(1500)).toBe("1.5k");
  expect(compact(2_500_000)).toBe("2.5M");
});
