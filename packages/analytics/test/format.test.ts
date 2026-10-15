import { expect, test } from "bun:test";
import { fmtMs } from "../src/index";

// Turns can run for hours, and "384.0m" is hard to read.
test("fmtMs switches to hours past one hour", () => {
  expect(fmtMs(812)).toBe("812ms");
  expect(fmtMs(12_100)).toBe("12.1s");
  expect(fmtMs(59 * 60_000)).toBe("59.0m");
  expect(fmtMs(6.4 * 3_600_000)).toBe("6.4h");
});
