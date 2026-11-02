// Who owns a hook command: the plugin or settings file that configures it. Reuses the
// collector's resolution (telemetry registrations matched against config files), so this
// answers the same way the details window does.
import { buildHookDefinitions, hookSummary, type HookDefinition } from "@cpa/collector/src/hooks";
import { hostContext, LOCAL_HOST_ID } from "@cpa/collector/src/hosts";
import { gitRoot } from "@cpa/collector/src/repos";
import type { EventRow } from "@cpa/otlp";

export interface Owner {
  label: string;
  configPath: string | null;
}

export interface OwnerIndex {
  // Owners of an exact command string, for one hook event.
  byCommand(hookEvent: string, command: string): Owner[];
  // Every hook configured for an event, for blocks no command could be matched to.
  forEvent(hookEvent: string): { command: string | null; summary: string; owner: Owner }[];
}

function ownerOf(d: HookDefinition): Owner {
  const label = d.source === "plugin" ? `plugin ${d.plugin ?? "?"}` : `${d.source} settings`;
  return { label, configPath: d.configPath };
}

export function buildOwnerIndex(registrations: EventRow[], cwdBySession: Map<string, string | null>, hookEvents: string[]): OwnerIndex {
  const ctx = hostContext(LOCAL_HOST_ID);
  const rootFor = (sid: string) => {
    const cwd = cwdBySession.get(sid);
    return cwd ? (gitRoot(cwd)?.root ?? cwd) : null;
  };
  const defsByEvent = new Map<string, HookDefinition[]>();
  for (const ev of new Set(hookEvents)) {
    if (!ev) continue;
    try {
      defsByEvent.set(ev, buildHookDefinitions(ev, registrations, rootFor, ctx));
    } catch {
      defsByEvent.set(ev, []);
    }
  }
  return {
    byCommand(hookEvent, command) {
      const seen = new Set<string>();
      const out: Owner[] = [];
      for (const d of defsByEvent.get(hookEvent) ?? []) {
        if (d.command !== command) continue;
        const o = ownerOf(d);
        const key = `${o.label}|${o.configPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(o);
        }
      }
      return out;
    },
    forEvent(hookEvent) {
      return (defsByEvent.get(hookEvent) ?? []).map((d) => ({
        command: d.command,
        summary: d.command ? hookSummary(d.command) : d.summary,
        owner: ownerOf(d),
      }));
    },
  };
}

export function ownerText(owners: Owner[]): string {
  if (!owners.length) return "owner unknown";
  return owners.map((o) => (o.configPath ? `${o.label} (${o.configPath})` : o.label)).join(" or ");
}
