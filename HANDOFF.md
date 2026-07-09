# HANDOFF — state and next work

*Last updated: 2026-07-02. Built in Cowork; handed off to Claude Code.*

## Where things stand

**V1 + V2 are code-complete, tested (49/49), typecheck clean, pushed to main.**

Working today: session lifecycle (`/session/start|mark|end`), record control, health checks + 30s monitor with macOS notifications, NAS rsync with retries, profile system (podcast/music/dj/content in studio.yaml), ATEM client (atem-connection, behind `atem.enabled` flag), rule-based auto-switching (rotation + manual-override pause + kill switch), audio-reactive closeup cuts (OBS InputVolumeMeters), take auto-renaming, dashboard at `GET /`.

**Real-hardware checks PASSED (2026-07-02):** ATEM confirmed as **ATEM Mini Pro ISO** at 192.168.1.99 (MAC 7c:2e:0d:1f:31:3f — needs a DHCP reservation), studio.yaml updated with `atem.enabled: true`. Daemon `POST /cut/2` smoke test verified against live ATEM state. Auto-switch dry run on the podcast profile: rotation cuts within 5–15s bounds, never repeated current cam, kill switch disarmed instantly. OBS 32.1.2 connected (note: OBS WebSocket auth appears OFF — config password is still CHANGE_ME and it connects anyway).

**Manual test plan steps 1–7 + 10 PASSED against real OBS 32.1.2 (2026-07-04).** Session lifecycle, 409 on double start, record + take auto-rename (take1/take2), marker math (5017ms at ~5s), manifest, crash safety (daemon killed mid-take → OBS kept recording) all verified live. It shook out one real bug — duplicate/stale file entries in session.json after take rename — fixed in 089d41a (see noteFileRenamed in session.ts). Disk was cleared to ~72 GB free; health fully green.

Chapter markers: OBS currently records **MKV**, so CreateRecordChapter is rejected (warn logged, marker still succeeds). To get real in-file chapters, switch OBS output format to **Hybrid MP4** (Settings → Output → Recording). Note recording bitrate observed ~12 MB/s (~42 GB/hr) — budget disk accordingly.

## Immediate next steps (before ANY new features)

1. ~~**Wire the Stream Deck**~~ **DONE 2026-07-09** — built a dedicated **"ORCHESTRA" profile** on the Stream Deck + (via the app UI, driven by computer-use, no risk to the user's 40 existing profiles). 7 keys, all "System → Open" actions pointing at the tested trigger apps in `~/Documents/ORCHESTRA-StreamDeck/`: row 1 = GO / CAM1 / CAM2 / KILL, row 2 = MARK / END / REEL. Verified the .app→daemon→ATEM chain live (launching CAM1-HERO.app cut the real ATEM to program 1 — identical to a physical key press). Only the literal physical press is untested (can't press hardware via automation) — user presses GO to confirm. REEL.app switches to the dj profile before running the reel so it works regardless of active profile. The three approaches, for reference:
   - **Elgato Stream Deck MCP (AI-native, set up 2026-07-09)** — official `@elgato/mcp-server` (v0.1.1, installed globally) registered in Claude Code user config (`claude mcp add elgato`, shows Connected). Stream Deck app updated to **7.5.0** and **MCP Deck already enabled** (`MCP_enabled=1` in `defaults read com.elgato.StreamDeck`, creates the "MCP Actions" profile). Exposes 5 tools: `streamdeck__list_actions`, `get_executable_actions`, `execute_action`, `get_context`, `invoke_plugin_method` — lets Claude LIST + EXECUTE Stream Deck actions (AI-driven control), NOT lay out physical buttons. **REQUIRES a Claude Code session restart** for the elgato tools to load (MCP servers enumerate at startup; not hot-loadable). Model: put actions (e.g. an Open→GO.app action, or the installed OBS/amaran plugin actions) in the MCP Actions profile + annotate with AI descriptions, then Claude triggers them by intent. Setup ref: https://www.elgato.com/ww/en/explorer/products/stream-deck/sd-mcp-setup/
   - **Trigger apps (ready NOW, plugin-free)** — see below.
   - **Trigger apps (ready NOW, plugin-free)** — `tools/build-streamdeck-triggers.sh` builds silent .apps in `~/Documents/ORCHESTRA-StreamDeck/` (GO/MARK/END/CAM1/CAM2/REEL/KILL), each fires one daemon curl. Assign via the Elgato app's built-in System→Open action. Verified live (CAM cuts fire the real ATEM). See `docs/streamdeck-triggers.md`. This is the "works today with your existing Elgato app" path — user just drags each .app onto a key (they declined letting me drive their Stream Deck app, so this last drag step is theirs).
   - **Bitfocus Companion (installed 2026-07-09, richer)** — for buttons that change COLOR on state (recording/health/capture-frozen). Companion v4.3.4 is installed + running (localhost:8000), daemon wired (`companion.enabled: true`). Blocked only on building the page: its admin is a browser UI and the claude-in-chrome extension was disconnected this session. Full button map in `docs/companion-setup.md`. Full button map in `docs/companion-setup.md` (rewritten for the /go macro, capture-freeze feedback, confirmed camera map, cinematic reel). Daemon side is DONE: `companion.enabled: true` in studio.yaml, pushing `orchestra_health` + `orchestra_capture`. Remaining = install Companion (https://bitfocus.io/companion), add Stream Deck as a Surface, enable its HTTP API, build the STUDIO page per the guide. NOTE: the user runs the **Elgato Stream Deck app**, NOT Companion — Companion must be installed; the Elgato app alone can't POST to the daemon. The old Companion guide (84c8c58) is superseded by the current docs/companion-setup.md.
2. Auto-switch step 9 partial: rotation + kill switch verified live 2026-07-02; manual-override pause + audio-closeup rule not yet exercised against hardware (ATEM was powered off on 2026-07-04). Needs OBS open + ATEM powered on.
3. ~~NAS: set up SSH key auth, test sync~~ SUPERSEDED (2026-07-04): storage workflow is now T9 (record/cull) → manual export to NAS. `nas.enabled` stays `false` on purpose — step 11 of the manual test plan (auto-rsync) does not apply to this workflow and should be skipped, not fixed.
4. Consider switching OBS to Hybrid MP4 for chapter-marker support (see above). Needs OBS open — one settings toggle.
5. Log the first real recorded session — 0 of the 10 required for the V3 gate so far (hardware validation + smoke tests don't count as "sessions").

## Known gaps / small tickets (V2 polish)

- amaran lighting: NOT implemented. Blocked on the user's Sidus OpenAPI token (applied-for; takes days). When granted: `src/clients/amaran.ts` calling the local amaran Desktop OpenAPI, `lightingPreset` per profile already exists in config, apply on session start.
- ~~Companion feedback push~~ DONE (2026-07-02): `src/clients/companion.ts` pushes `orchestra_health` (`ok`/`fail`) to Companion custom variables on health-monitor transitions. Gated by `companion.enabled` in studio.yaml; needs Companion's HTTP API enabled. Fire-and-forget, 2s timeout, never affects the studio.
- ~~OBS chapter markers~~ DONE (2026-07-02): `/session/mark` also calls obs-websocket `CreateRecordChapter` (cleaner than the hotkey) while recording. Best-effort; needs OBS 30.2+ recording Hybrid MP4. Toggle: `obs.chapterMarkers` (default true).
- ~~launchd plist placeholder paths~~ DONE (2026-07-02): plist now points at `~/Documents/GitHub/ORCHESTRA` and node at `~/.local/node/bin/node` (verified via `which node` — homebrew node is NOT installed on this machine).

## V3 — GATE OVERRIDDEN 2026-07-09 by explicit user decision

The gate below ("do not start until 10+ clean real sessions") was real project policy from 2026-07-02 through 2026-07-09, and is the reason C1–C6 sat untouched. On 2026-07-09 the user explicitly chose to override it and build the full cinematic-automation vision now (one Stream Deck button → lighting + camera switching + gimbal + storage), accepting the reliability risk on an unproven V2 base. Record any future full-gate override the same way: explicit, dated, in this file — don't infer it from silence.

Original order, from the build plan (studio-director-build-plan.md in the user's files):

- C1. OBS → RTSP/SRT feed reachable from the Jetson Orin AGX; measure latency.
- C2. `director-eyes` on Jetson (Python): person detection + shot scoring → MQTT `eyes/suggestion {cam, score, reason}` @ ~2 Hz.
- C3. mosquitto broker + policy engine in this daemon blending audio rules + vision suggestions + hysteresis. Kill switch stays on the Stream Deck.
- C4. Sony Camera Remote SDK wrapper (C++ → small binary the daemon shells to): record tally + Power Zoom presets on the 16-35 PZ (A7 IV first).
- C5. DJI RS4 gimbal spike, timeboxed 1 week: verify RS 4 (non-Pro) on the DJI R SDK supported list → CAN adapter + presets, else Intelligent Tracking Module. Do not extend the timebox.
- C6. Mission Control/Maestro integration: publish session events (started/ended/markers/paths) over MQTT; session metadata → Postgres on the NAS.

The cinematic-automation build (below) supersedes/reorders C4–C6 for the "one button = mini cinematic reel" goal; C1–C3 (Jetson vision) are unrelated to that goal and remain untouched.

## Cinematic cue-sequencer — BUILT 2026-07-09 (tested, verified live)

New scripted (non-random) multi-cam mode, separate from `autoSwitch`'s rotation engine, for producing a fixed-length cinematic reel (e.g. a 90s DJ mixing reel: wide → slider → overhead → cutaway) instead of random cuts.

- `src/switcher.ts`: `CueSequenceEngine` — same clock-free `tick(nowMs)`-driven shape as `AutoSwitchEngine` (see CLAUDE.md testing conventions). Plays an ordered `SequenceCue[]` list, self-disarms when the list completes, and — unlike rotation mode — a manual cut **aborts** the sequence rather than pausing it (resuming a timed script after an unplanned interruption doesn't make sense). `Director` now holds either engine (`mode: 'rotation' | 'sequence' | null`), mutually exclusive, single ticker.
- `src/config.ts`: `sequences: Record<string, SequenceCue[]>` added to `ProfileSchema` — named cue lists per profile, defined in `studio.yaml`.
- `src/http.ts`: `POST /sequence/:name/run` (400 if `atem.enabled=false`, 404 if the active profile has no sequence with that name) and `GET /sequences` (list available names for the active profile).
- Tests: `test/switcher.test.ts` (CueSequenceEngine: in-order cuts on schedule, self-finish, manual-abort, empty-list no-arm). 58/58 total passing, typecheck clean.
- Verified live end-to-end against the real daemon (with ATEM physically off, to confirm graceful degradation): armed, cut on schedule at the exact configured `holdMs` boundaries, self-disarmed after the last cue, no hang.
- **Not yet done**: the live `studio.yaml` `dj` profile has no real `sequences` defined — `config/studio.example.yaml` has a fully-commented `mixingReel` example, but its `cam` numbers are PLACEHOLDERS. Confirm the ATEM's actual input-to-label mapping in ATEM Software Control (cables were labeled `CAM SLIDER` / `OVERHEAD` / `REAR SCREEN` + one unlabeled input in the photos) before copying real numbers into `studio.yaml`.
- **Not yet done**: no macro endpoint ties `/session/start` + `/record/start` + `/sequence/:name/run` into one Stream Deck press yet — right now it's 3 curl calls. Natural next increment once the real cue numbers are confirmed.

## Cinematic recording pipeline — BUILT + VERIFIED LIVE 2026-07-09

Full plan in `docs/cinematic-recording-plan.md`. Goal: one Stream Deck button → hands-free multi-cam cinematic reel (Shaughn can't mix and switch at once).

**Camera map CONFIRMED live** (cut each input via daemon, watched OBS): CAM1 = back-wall wide HERO, CAM2 = OVERHEAD (top-down decks). CAM3/CAM4 empty (slider + gimbal later). The `dj` profile's `mixingReel` sequence uses CAM1/CAM2.

**Key hardware finding:** ATEM Mini Pro ISO's single USB-C is webcam-out-to-Mac **OR** record-to-SSD, never both (Blackmagic forum confirmed). It's on the Mac, and clean audio comes from the Apollo Twin mapped in OBS → **OBS is the recorder**, ATEM switching runs over Ethernet in parallel. ISO-to-SSD is NOT viable without freeing the USB-C (would strand Apollo audio). Phase-2 upgrade path: ATEM HDMI-out → Elgato Cam Link frees the USB-C for an SSD + gives a rock-solid feed.

**Built this session (all verified live against real OBS + ATEM, 65/65 tests):**
- **`POST /go`** one-button macro (`src/http.ts`): open session → start recording → run named sequence, one call. Verified: single call started session + record + watchdog + mixingReel together.
- **Capture watchdog** (`src/capture-watchdog.ts`): while recording, polls the OBS capture source via `GetSourceScreenshot` frame-hashing; on a frozen/dropped feed (the flaky Blackmagic UVC bug we hit) fires instant macOS notification + Companion `orchestra_capture` push. Optional `autoRecover`. Verified: NO false-alarm on the live moving feed (frame hashes change every second), arms/disarms exactly with recording. Config: `obs.captureSource` + `obs.captureWatchdog` (live studio.yaml set to `"ATEM PROGRAM"`, enabled).
- OBS reliability note: the Blackmagic UVC capture drops intermittently (device disappears from macOS). Fix = recreate the capture SOURCE (delete + re-add), not just re-pick the device; plus direct USB-C cable / no hub. This is the main remaining physical reliability task.

## Hardware SDK investigation — 2026-07-09 (Sony / DJI / amaran)

Findings before writing any driver code, so the build doesn't chase dead ends:

**Sony Camera Remote SDK — real, but manual step required.** Both cameras on the rig — **Sony A7C and A7 IV** — are confirmed on Sony's official supported-camera list. Real path: register as a Sony developer, download the C++ SDK, compile a small binary ORCHESTRA shells out to, control ISO/aperture/record-trigger per camera. **Not started**: registering for the SDK means accepting Sony's developer license agreement, which is the kind of "accept terms on your behalf" action Claude Code should not do silently — needs the user to register and accept the EULA themselves; I can write the wrapper/binary integration once the SDK is downloaded. Two cameras also means the daemon needs to track two independent camera sessions (likely USB, one config entry per camera), not just one.

**DJI RS4 gimbal — genuinely risky, proceeding anyway per explicit user decision.** Searched DJI's own forums: multiple users report **no signal** trying to drive the RS4 over its CAN port with USB-CAN adapters, and DJI's downloads page reportedly serves the older RS2-era "R SDK" rather than a true RS4 SDK — this matches (and validates) the caution in the original C5 spike description. User's explicit call: "do not skip, I bought this gimbal because SDK control was supposed to be possible; treat it as a separate cam angle but set up the necessary infrastructure." So: build the ATEM-side plumbing so the gimbal is just another numbered input in cue sequences (works regardless of SDK outcome — no dependency), and separately timebox the actual CAN-bus SDK spike as C5 originally specified (1 week, do not extend, fall back to manual/app-driven operation if it fails). **DJI Ronin desktop app is already installed** on this Mac (`/Applications/DJI Ronin.app`) — not yet inspected for an official "request SDK access" flow like amaran's; check that before attempting raw CAN-bus code.

**amaran lighting — token path was wrong; real path found, blocked on computer-use contention.** HANDOFF previously said this was "blocked on a pending Sidus OpenAPI token, applied for, takes days" — checked Gmail, **no such application was ever actually submitted** (only a Dec 2025 amaran Creators mobile-app login exists). The real mechanism: **amaran Desktop.app is already installed** on this Mac, with an existing Elgato Stream Deck plugin (`com.amarancreators.controller.sdPlugin`) already present — so the lights are already controllable manually from the Stream Deck today, outside ORCHESTRA. For programmatic control: launched the app, found it runs a local Python `websockets` server (two ports appeared: `12345` and `33782`), but both are silent to blind unauthenticated probes — the sanctioned path is applying for OpenAPI/local-control access from inside the app's own UI (Settings), same "day or two" review wait but at least self-serve, not email-based. **Blocked this session**: computer-use was locked by another concurrent Claude session when I tried to drive the UI. Next session: get computer-use access, open amaran Desktop → find and submit the OpenAPI/developer access request, then get the actual local API's request/response format from its docs once granted (do not reverse-engineer the raw WebSocket protocol blind).

## Reference material on this machine (found 2026-07-02)

- **Blackmagic ATEM Switchers SDK** (822-page PDF): `/Applications/Blackmagic ATEM Switchers/Developer SDK/Blackmagic Switchers SDK.pdf`. Official COM/C++ API — we do NOT link it (atem-connection speaks the network protocol from Node). Use it as the authoritative reference for input IDs / model capabilities if atem-connection misbehaves during hardware bring-up. ATEM Software Control + ATEM Setup are installed alongside it (use ATEM Setup to confirm model + IP for the smoke test). Note for V3: `IBMDSwitcherInput::SetViscaDeviceId` — some ATEMs can proxy VISCA camera control.
- **OBS source snapshot**: `~/Downloads/obs-studio-master/` (GitHub ZIP of master). CAVEAT: `plugins/obs-websocket` is a git submodule and is EMPTY in a ZIP download — for websocket protocol details use https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md instead. The snapshot is still useful for frontend/libobs internals; verified there that `obs_frontend_recording_add_chapter` returns false when not recording OR when paused (so chapter markers silently fail during a paused recording — our /session/mark logs a warn and the JSON marker still succeeds).
- OBS developer guide: https://obsproject.com/kb/developer-guide

## Storage workflow (decided 2026-07-04)

Record to the **Samsung T9** (`/Volumes/T9-Content/RECORDING_SESSIONS`, exFAT) as the short-term working drive → cull/edit from there → export FINALS to the UGREEN NAS by hand. `nas.enabled` stays **false** on purpose: auto-sync would ship every raw take. NAS is at **192.168.1.225** (not the .50 placeholder); its SMB shares are usually mounted (e.g. `/Volumes/06_VIDEO_PROJECTS`), so export = drag/rsync. The daemon guards the T9: boot and `/session/start` refuse when the volume is unmounted (`volumeRootOf` + `isVolumeMounted`), and `/health` has a `recordingVolume` check. WATCH: T9 was 92% full (~327 GB free ≈ 7.7 h at observed bitrate) — cull aggressively or clear space.

## Context the code can't tell you

- The user (Shaughn) runs DICHEEKO Studio; this ties into a broader "Mission Control / Brain Router" architecture later — `orchestra` should stay a clean standalone service it can talk to.
- Original architecture decision: Companion is the glue for V1 hardware control; the daemon is the single source of truth for state; hardware is never the brain; Jetson (V3) only *suggests* cuts over MQTT.
- Recording locally then syncing exists because a network hiccup mid-take is unacceptable (hard-learned lesson).
