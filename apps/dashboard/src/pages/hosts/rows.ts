// Pure helpers for the Remote hosts page: what each host row says about its state.
import { clock } from "../../format";
import { LOCAL_HOST_ID, lastSeenText, type Host } from "../../hosts";

export type HostRow = { host: Host; local: boolean; waiting: boolean; detail: string };

// This Mac first, then remotes in the order the collector returns them.
export function hostRows(hosts: Host[], now: number): HostRow[] {
  const local = hosts.find((h) => h.id === LOCAL_HOST_ID);
  const remotes = hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  const rows: HostRow[] = [];
  if (local) rows.push({ host: local, local: true, waiting: false, detail: "local, this collector" });
  for (const h of remotes) {
    const waiting = h.lastSeenMs === null;
    const added = h.createdMs === null ? null : `added ${clock(h.createdMs)}`;
    const detail = waiting ? [added, "no telemetry yet"].filter(Boolean).join(", ") : lastSeenText(h, now);
    rows.push({ host: h, local: false, waiting, detail });
  }
  return rows;
}

export type Pending = { id: string; action: "rotate" | "remove" };

export function confirmText(p: Pending, name: string): string {
  return p.action === "rotate"
    ? `Rotate the token for ${name}? The current token stops working at once.`
    : `Remove ${name}? Its token stops working and all telemetry saved from this host is deleted.`;
}
