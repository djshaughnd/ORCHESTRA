# ORCHESTRA

Local studio-automation daemon for DICHEEKO Studio — the backend of a one-button recording platform. Node 20 + TypeScript + Fastify. Reliability over features.

The Stream Deck (via Bitfocus Companion) is the UI. ORCHESTRA handles what Companion can't: session folders, file naming, manifests, health checks, post-session NAS sync — and, in V2 mode, profile-driven rule-based auto-switching with audio-reactive cuts.

```
Stream Deck → Companion → { ATEM (Ethernet), OBS (WebSocket :4455), ORCHESTRA (HTTP :8722) }
                                   ▲ (optional V2: daemon cuts the ATEM directly via atem-connection)
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

Logs land in `logs/orchestra.log` (plus launchd stdout/err logs). A live status dashboard is served at `http://127.0.0.1:8722/` — nice on an iPad in the booth.

## HTTP API

All JSON, on `http://127.0.0.1:8722`.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/session/start` | `{name?, profile?}` | Creates dated session folder (profile template), switches OBS scene collection, points OBS record dir at it, starts the health monitor. 409 if a session is active. |
| POST | `/session/mark` | `{label?}` | Timestamped marker. 409 if no session. |
| POST | `/session/end` | — | Stops recording if running, writes `session.json`, fires NAS sync, stops monitor + auto-switch, returns manifest. |
| POST | `/record/start` | — | OBS StartRecord. 409 if no session. |
| POST | `/record/stop` | — | OBS StopRecord. **Always attempts**, never 409s. Finished takes are auto-renamed to the profile's `fileTemplate`. |
| POST | `/cut/:cam` | — | ATEM program cut (requires `atem.enabled: true`). Also registers a manual override that pauses auto-switching. |
| POST | `/auto/arm` | — | Arm rule-based auto-switching using the active profile. 400 if disabled in config. |
| POST | `/auto/disarm` | — | **Kill switch.** Always succeeds. |
| GET | `/profiles` | — | Active + available profiles. |
| POST | `/profile/:name` | — | Switch active profile (podcast / music / dj / content / default). |
| GET | `/health` | — | Parallel checks (2s timeouts): OBS, disk free, NAS ping, OBS dropped frames. Never throws. |
| GET | `/status` | — | Session, profile, auto-switch state, OBS/ATEM connectivity, record state, uptime. |
| GET | `/` | — | Live HTML dashboard (polls /status + /health). |

## Companion buttons (Generic HTTP module)

Point Companion's **Generic HTTP** instance at `http://127.0.0.1:8722`, then:

**GO** (one button = session + record):

```bash
curl -X POST http://127.0.0.1:8722/session/start -H 'Content-Type: application/json' -d '{"name":"podcast"}'
curl -X POST http://127.0.0.1:8722/record/start
```

**MARK** / **END** / **HEALTH**:

```bash
curl -X POST http://127.0.0.1:8722/session/mark -H 'Content-Type: application/json' -d '{"label":"good take"}'
curl -X POST http://127.0.0.1:8722/session/end
curl http://127.0.0.1:8722/health
```

**Profile select** (one button per profile) and **auto-director**:

```bash
curl -X POST http://127.0.0.1:8722/profile/podcast
curl -X POST http://127.0.0.1:8722/auto/arm
curl -X POST http://127.0.0.1:8722/auto/disarm    # KILL SWITCH — keep this on the deck
curl -X POST http://127.0.0.1:8722/cut/2          # manual cut (pauses auto for N seconds)
```

Use the `/health` response's `ok` field for button feedback color.

## Auto-switching rules (V2)

Configured per profile in `studio.yaml` under `autoSwitch`:

- Rotation: random camera from `cameras` after a random shot length in `[minShotSeconds, maxShotSeconds]`. Never repeats the current cam, never machine-guns.
- Manual override always wins: any `/cut` pauses auto mode for `overridePauseSeconds`.
- Audio rule: sustained level (≥ `thresholdDb` for `sustainMs`) on `audio.obsInput` favors `closeupCam`. Driven by OBS `InputVolumeMeters` — zero ML, ~70% of the "AI director" feel.
- The auto-director is **advisory-plumbing only**: a dead daemon degrades to manual Companion buttons; the ATEM hardware panel always works.

Requires `atem.enabled: true` (daemon connects to the ATEM over Ethernet via `atem-connection`). With `atem.enabled: false` the daemon stays in V1 mode and Companion drives all cuts.

## Behavior guarantees

- OBS client auto-reconnects with exponential backoff (1s → 30s cap) and re-queries record state on reconnect. Commands fail fast when OBS is down — HTTP requests never hang.
- `session/end` is crash-safe: `session.json` is written **before** NAS sync starts. Sync failures retry ×3 and never block the response.
- SIGTERM never stops an active recording — OBS outlives the daemon by design.
- Recording is **local SSD only**; sync to NAS happens post-session via rsync `--checksum`.
- Health monitor runs every 30s while a session is armed; failures fire a macOS notification (transitions only, no spam).
- Every device command is logged with a `sessionId` correlation field.

## Manual test plan (run with OBS open)

1. **Boot:** `npm start` with a bad password in `studio.yaml` → daemon logs OBS connect failures with backoff. Fix → `connected to OBS WebSocket`.
2. **Health:** `curl localhost:8722/health` → `ok: true`. Quit OBS → `ok: false` with clear detail. Reopen → auto-reconnect within ~30s.
3. **Dashboard:** open `http://127.0.0.1:8722/` — tiles update every 2s.
4. **Session start:** `curl -X POST localhost:8722/session/start -d '{"name":"smoke test"}' -H 'Content-Type: application/json'` → dated folder exists, OBS record path points there. Same call again → 409.
5. **Record + rename:** `curl -X POST localhost:8722/record/start`, wait 10s, `curl -X POST localhost:8722/record/stop` → file in the session folder renamed to `<date>_<profile>_take1.<ext>`. Record again → `take2`.
6. **Markers:** while recording, MARK → `sinceRecordStartMs` matches the elapsed time.
7. **End:** `curl -X POST localhost:8722/session/end` → `session.json` lists takes, markers, files.
8. **Profiles:** `curl -X POST localhost:8722/profile/podcast` → `/status` shows it; session folders use the podcast template.
9. **Auto-switch** (needs `atem.enabled: true` + ATEM on the LAN): `curl -X POST localhost:8722/auto/arm` → cuts every 5–15s, never the same cam twice. `curl -X POST localhost:8722/cut/1` → auto pauses ~20s. Speak into the mic ≥1.5s → cut to closeup cam. `/auto/disarm` → stops instantly.
10. **Crash safety:** start session + record, `kill -TERM <pid>` → loud warning, OBS keeps recording.
11. **NAS sync** (once `nas.enabled: true`): end a session → `NAS sync complete` in log; folder on NAS. Pull NAS cable → 3 retries, session stays local, daemon unaffected.

## Roadmap

V1 ✅ session lifecycle, health, sync. V2 ✅ (this code): profiles, ATEM client, rule-based auto-switching, audio-reactive cuts, take renaming, health monitor, dashboard. V3 (gated on 10 clean V2 sessions): Jetson vision node over MQTT, Sony Camera Remote SDK (PZ zoom moves), amaran OpenAPI lighting, Mission Control integration.
