import { expect, test } from "bun:test";
import { eventDetails } from "../src";

const row = (name: string, attrs: Record<string, unknown>) => ({ tsMs: 0, name, sessionId: null, promptId: null, attrs });
const value = (details: { key: string; value: string }[], key: string) => details.find((d) => d.key === key)?.value;

test("detail values carry units, not raw attribute numbers", () => {
  const api = eventDetails(row("api_request", { model: "m", ttft_ms: "1957", cost_usd: "0.05" }));
  expect(value(api, "TTFT")).toBe("2.0s");
  expect(value(api, "Cost")).toBe("$0.0500");

  const tool = eventDetails(row("tool_result", { tool_name: "Bash", tool_input_size_bytes: "576", tool_result_size_bytes: "2048" }));
  expect(value(tool, "Input size")).toBe("576 B");
  expect(value(tool, "Result size")).toBe("2.0 KB");
});

test("prompt text never shows up in details", () => {
  const all = ["user_prompt", "api_request", "tool_result", "hook_execution_complete", "subagent_completed"].flatMap((n) =>
    eventDetails(row(n, { prompt: "secret prompt", prompt_text: "secret prompt" })),
  );
  expect(all.some((d) => d.value.includes("secret prompt"))).toBe(false);
});
