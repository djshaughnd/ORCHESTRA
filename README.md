# ORCHESTRA

Local studio-automation daemon for DICHEEKO Studio — the MVP backend of a one-button recording platform. Node 20 + TypeScript + Fastify. No AI, no auto-switching in this version. Reliability over features.

The Stream Deck (via Bitfocus Companion) is the UI. ORCHESTRA handles what Companion can't: session folders, file naming, manifests, health checks, and post-session sync to the NAS.

```
Stream Deck → Companion → { ATEM (Ethernet), OBS (WebSocket :4455), ORCHESTRA (HTTP :8722) }
```

## Setup

**1. Enable the OBS WebSocket server** (OBS 28+ has it built in):
OBS → Tools → WebSocket Server Settings → check *Enable WebSocket server* → set a password → Apply. Port stays 4455.

**2. Install and configure:**

```bash
git clone https://github.com/djshaughnd/ORCHESTRA.git
cd ORCHESTRA
npm install
cp config/studio.example.yaml config/studio.yaml
# edit config/studio.yaml — set obs.password, atem.ip, recordingsRoot
```

The daemon fails loudly at boot with a readable message if the config is invalid.

**3. Run it:**

```bash
npm start          # foreground
npm run dev        # foreground with reload on change
npm test           # unit tests
npm run typecheck
```

**4. Install as a launchd service** (starts at login, restarts on crash):

```bash
# Edit launchd/com.dicheeko.orchestra.plist first:
#   - fix the node path (`which node`)
#   - fix the repo path if not ~/studio/orchestra
cp launchd/com.dicheeko.orchestra.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.dicheeko.orchestra.plist
launchctl list | grep orchestra   # verify running

# Stop / restart:
launchctl unload ~/Library/LaunchAgents/com.dicheeko.orchestra.plist
```

Logs land in `logs/orchestra.log` (plus launchd stdout/err logs).

## HTTP API

All JSON, on `http://127.0.0.1:8722`.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/session/start` | `{name?, profile?}` | Creates dated session folder, points OBS record dir at it. 409 if a session is active. |
| POST | `/session/mark` | `{label?}` | Timestamped marker. 409 if no session. |
| POST | `/session/end` | — | Stops recording if running, writes `session.json`, fires NAS sync, returns manifest. |
| POST | `/record/start` | — | OBS StartRecord. 409 if no session. |
| POST | `/record/stop` | — | OBS StopRecord. **Always attempts**, never 409s. |
| GET | `/health` | — | Parallel checks (2s timeouts): OBS, disk free, NAS ping. Never throws. |
| GET | `/status` | — | Current session, OBS record state, uptime. |

## Companion buttons (Generic HTTP module)

Point Companion's **Generic HTTP** instance at `http://127.0.0.1:8722`, then:

**GO** (one button = session + record) — two actions in sequence:

```bash
curl -X POST http://127.0.0.1:8722/session/start -H 'Content-Type: application/json' -d '{"name":"podcast"}'
curl -X POST http://127.0.0.1:8722/record/start
```

**MARK** (good-take marker):

```bash
curl -X POST http://127.0.0.1:8722/session/mark -H 'Content-Type: application/json' -d '{"label":"good take"}'
```

**END** (stop + manifest + NAS sync):

```bash
curl -X POST http://127.0.0.1:8722/session/end
```

**HEALTH** (green/red readiness button):

```bash
curl http://127.0.0.1:8722/health
```

In Companion, add these as HTTP POST/GET actions on buttons; use the `/health` response's `ok` field for button feedback color.

## Behavior guarantees

- OBS client auto-reconnects with exponential backoff (1s → 30s cap) and re-queries record state on reconnect. Commands fail fast when OBS is down — HTTP requests never hang.
- `session/end` is crash-safe: `session.json` is written **before** NAS sync starts. Sync failures retry ×3 and never block the response.
- SIGTERM never stops an active recording — OBS outlives the daemon by design. The ATEM hardware panel and OBS hotkeys always work regardless of daemon state.
- Recording is **local SSD only**; sync to NAS happens post-session via rsync `--checksum`.
- Every device command is logged with a `sessionId` correlation field.

## Manual test plan (run with OBS open)

1. **Boot:** `npm start` with a bad password in `studio.yaml` → confirm daemon logs OBS connect failures and retries with backoff. Fix the password → confirm `connected to OBS WebSocket` in the log.
2. **Health:** `curl localhost:8722/health` → `ok: true`, obs + disk checks pass. Quit OBS → health goes `ok: false` with a clear obs detail. Reopen OBS → daemon auto-reconnects within ~30s.
3. **Session start:** `curl -X POST localhost:8722/session/start -d '{"name":"smoke test"}' -H 'Content-Type: application/json'` → folder `~/Recordings/<date>_<time>_smoke-test/` exists, OBS Settings → Output shows the record path pointed there.
4. **409 guard:** run the same start again → HTTP 409.
5. **Record:** `curl -X POST localhost:8722/record/start` → OBS shows REC. Wait 10s. `curl -X POST localhost:8722/session/mark -d '{"label":"t1"}' -H 'Content-Type: application/json'` → returns marker with `sinceRecordStartMs` ≈ 10000.
6. **End:** `curl -X POST localhost:8722/session/end` → OBS stops recording; `session.json` in the session folder lists the .mkv/.mp4 file and the marker; response is the manifest.
7. **Weird-state stop:** with no session, `curl -X POST localhost:8722/record/stop` → 200, `outputPath: null` (never errors).
8. **Crash safety:** start a session + recording, `kill -TERM <pid>` → daemon exits with a loud warning, OBS **keeps recording**. Restart daemon, `curl localhost:8722/status` → `record.active: true`.
9. **NAS sync** (once `nas.enabled: true`): end a session → watch `logs/orchestra.log` for `NAS sync complete`; verify the folder on the NAS. Pull the NAS cable and end another session → 3 retry log lines, session stays local, daemon unaffected.

## Roadmap

V1 (this repo): session lifecycle, health, sync. V2: profiles in `studio.yaml`, `atem-connection` client, rule-based auto-switching, audio-reactive cuts. V3: Jetson vision node over MQTT, Sony Camera Remote SDK, Mission Control integration. See `studio-director-build-plan.md` in the project docs.
