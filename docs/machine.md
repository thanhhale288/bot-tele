# Keep the home machine alive for Telegram

Phase 7 of the bot: `/machine` should stay truthful while you are away.

## Daemon on login

```bash
cd cursor-cp && npm run build
cursor-cp daemon enable
```

That installs a per-user LaunchAgent (macOS) or systemd user unit (Linux) with `KeepAlive` / restart on failure.

Repo helper:

```bash
./scripts/enable-autostart.sh
```

## Stay awake (macOS)

Sleep, lid-close, and "Power Nap" will stop the bot even if the daemon is enabled.

Foreground (until Ctrl+C):

```bash
./scripts/keep-awake.sh
```

LaunchAgent (survives logout of the terminal):

```bash
./scripts/keep-awake.sh --install
```

This runs `caffeinate -dims` (display, idle, disk, system).

Lid-close sleep is a **system** setting. Preview the `pmset` commands:

```bash
./scripts/disable-lid-sleep.sh
```

Apply only if you want the Mac to stay up with the lid shut (requires `sudo`):

```bash
./scripts/disable-lid-sleep.sh --apply
```

Restore defaults with `--restore`.

## Heartbeat

`cursor-cp` writes `~/cursor-cp/data/heartbeat.json` every minute. After a crash or sleep gap, the next start logs a warning and (if Telegram is enabled) pings allowlisted chats. `/machine` shows daemon state, uptime, disk, open tunnels, and a sleep warning when `pmset` sleep is on and caffeinate is not running.

## Stable `/ui` URL

Quick tunnels (`trycloudflare.com`) change every start. For a stable hostname:

1. Create a named Cloudflare tunnel and a DNS route.
2. Set in `config.yaml` (or env):

```yaml
server:
  tunnel_token: "..."
  tunnel_hostname: "https://cp.example.com"
  ui_token: "pick-a-long-secret"
```

Env aliases: `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_HOSTNAME`, `CURSOR_CP_UI_TOKEN`.

Remote `/ui` requires the token in the link. Localhost (`127.0.0.1`) stays open. Always send `/ui stop` when finished.

## Wake-on-LAN (optional)

If the Mac can sleep but WoL is enabled in firmware:

```yaml
machine:
  wol_mac: "aa:bb:cc:dd:ee:ff"
```

Then `/machine wake` from Telegram. The machine must still be powered and on the same LAN as something that can forward the packet (this bot cannot wake itself if it is already asleep — use another always-on host, or keep caffeinate on).
