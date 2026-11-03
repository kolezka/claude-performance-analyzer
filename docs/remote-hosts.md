# Remote hosts

Claude Code on another machine (Linux or macOS) can send its telemetry to the collector on this Mac over [Tailscale](https://tailscale.com) or your local network. Nothing of ours runs on the other machine.

## Add a host

1. On this Mac, open the Hosts section in the dashboard or the Hosts tab in the app's Settings, and add a host with a name.
2. Under "Reach this Mac at", pick the address the other machine should send to: this Mac's Tailscale address or one of its LAN addresses (for example `192.168.50.223`). Tailscale comes first when there is one.
3. Copy the `env` block it shows. It holds the host's token and the address you picked, and it is shown only once. Regenerate the token if you lose it.
4. Paste the block into the `env` of `~/.claude/settings.json` on the other machine and start a new Claude Code session there.

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

If this Mac has neither a Tailscale nor a LAN address when you add the host, the block says `<THIS_MAC_IP>`. Replace it with an address the other machine can reach, such as the one from `tailscale ip -4` or `ipconfig getifaddr en0`.

Over the LAN, telemetry and the token travel as plain HTTP. Anyone who can watch that network can read them. Tailscale encrypts the link, so prefer it on networks you do not control.

The setup button in the dashboard always configures this Mac, whichever host you have selected.

## What to expect

- Adding the first host makes the collector listen on all addresses (`::`, IPv4 and IPv6). macOS may ask once whether to allow incoming connections. Removing the last host takes it back to `127.0.0.1` only. Neither needs a restart.
- Remote data is accepted only from Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) or private LAN addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.0.0/16` and `fe80::/10`, unique local `fc00::/7`), and only with a valid token. Public addresses get `403`, a missing or wrong token gets `401`, and nothing is stored.
- The dashboard, the API, setup, host management and the live feed answer to this Mac only. A Tailscale or LAN peer gets `403` on all of them, even with a faked `Host` header.
- Removing a host deletes its token and all of its saved telemetry. Regenerating a token stops the old one at once.
- This Mac cannot see the other machine's disk, so remote rows show the paths as they were sent, with no repo name, worktree or branch lookup. Remote hooks show what telemetry registered (event, matcher, source, plugin), not the command or config file.
- The [MCP server](mcp.md) reads session transcripts, which stay on the machine that ran the session, so it covers sessions on this Mac only.
