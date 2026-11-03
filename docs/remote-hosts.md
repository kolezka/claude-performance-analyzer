# Remote hosts

Claude Code on another machine (Linux or macOS) can send its telemetry to the collector on this Mac over [Tailscale](https://tailscale.com). Nothing of ours runs on the other machine.

## Add a host

1. On this Mac, open the Hosts section in the dashboard or the Hosts tab in the app's Settings, and add a host with a name.
2. Copy the `env` block it shows. It holds the host's token and this Mac's Tailscale address, and it is shown only once. Regenerate the token if you lose it.
3. Paste the block into the `env` of `~/.claude/settings.json` on the other machine and start a new Claude Code session there.

The block looks like this:

```json
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://100.x.y.z:4318",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer cpa_...",
    "...": "the same telemetry variables as on this Mac"
  }
}
```

If this Mac has no Tailscale address when you add the host, the block says `<THIS_MAC_TAILSCALE_IP>`. Replace it with the address from `tailscale ip -4`.

The setup button in the dashboard always configures this Mac, whichever host you have selected.

## What to expect

- Adding the first host makes the collector listen on all addresses (`::`, IPv4 and IPv6). macOS may ask once whether to allow incoming connections. Removing the last host takes it back to `127.0.0.1` only. Neither needs a restart.
- Remote data is accepted only from Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and only with a valid token. Anything else gets `401` or `403` and nothing is stored.
- The dashboard, the API, setup, host management and the live feed answer to this Mac only. A tailnet peer gets `403` on all of them, even with a faked `Host` header.
- Removing a host deletes its token and all of its saved telemetry. Regenerating a token stops the old one at once.
- This Mac cannot see the other machine's disk, so remote rows show the paths as they were sent, with no repo name, worktree or branch lookup. Remote hooks show what telemetry registered (event, matcher, source, plugin), not the command or config file.
- The [MCP server](mcp.md) reads session transcripts, which stay on the machine that ran the session, so it covers sessions on this Mac only.
