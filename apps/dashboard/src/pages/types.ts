// Props every page component receives from App.svelte. Pages fetch their own detail data
// through a RequestGate and refetch when hostId, minutes or tick change.
import type { Summary } from "@cpa/analytics";
import type { EnvPlan } from "@cpa/claude-settings";
import type { Host } from "../hosts";
import type { Page } from "../route";

export interface PageProps {
  hostId: string;
  hostName: string;
  minutes: number;
  // Null until the first summary for this host arrives. Data pages render only once it is set.
  summary: Summary | null;
  // Bumped after every successful summary load (live events, 30s timer, window change).
  tick: number;
  // Hash params of the current route, e.g. { name: "PreToolUse:Bash" } on #/hooks?name=...
  params: Record<string, string>;
  navigate: (page: Page, params?: Record<string, string | number | undefined | null>) => void;
  hosts: Host[];
  hostsError: string | null;
  onHostsChanged: () => void;
  setup: EnvPlan | null;
  onSetupChanged: (plan: EnvPlan) => void;
}
