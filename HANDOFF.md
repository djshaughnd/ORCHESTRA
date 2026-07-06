# HANDOFF — state and next work

*Last updated: 2026-07-02. Built in Cowork; handed off to Claude Code.*

## Where things stand

**V1 + V2 are code-complete, tested (49/49), typecheck clean, pushed to main.**

Working today: session lifecycle (`/session/start|mark|end`), record control, health checks + 30s monitor with macOS notifications, NAS rsync with retries, profile system (podcast/music/dj/content in studio.yaml), ATEM client (atem-connection, behind `atem.enabled` flag), rule-based auto-switching (rotation + manual-override pause + kill switch), audio-reactive closeup cuts (OBS InputVolumeMeters), take auto-renaming, dashboard at `GET /`.

**Real-hardware checks PASSED (2026-07-02):** ATEM confirmed as **ATEM Mini Pro ISO** at 192.168.1.99 (MAC 7c:2e:0d:1f:31:3f — needs a DHCP reservation), studio.yaml updated with `atem.enabled: true`. Daemon `POST /cut/2` smoke test verified against live ATEM state. Auto-switch dry run on the podcast profile: rotation cuts within 5–15s bounds, never repeated current cam, kill switch disarmed instantly. OBS 32.1.2 connected (note: OBS WebSocket auth appears OFF — config password is still CHANGE_ME and it connects anyway).

**Manual test plan steps 1–7 + 10 PASSED against real OBS 32.1.2 (2026-07-04).** Session lifecycle, 409 on double start, record + take auto-rename (take1/take2), marker math (5017ms at ~5s), manifest, crash safety (daemon killed mid-take → OBS kept recording) all verified live. It shook out one real bug — duplicate/stale file entries in session.json after take rename — fixed in 089d41a (see noteFileRenamed in session.ts). Disk was cleared to ~72 GB free; health fully green.

Chapter markers: OBS currently records **MKV**, so CreateRecordChapter is rejected (warn logged, marker still succeeds). To get real in-file chapters, switch OBS output format to **Hybrid MP4** (Settings → Output → Recording). Note recording bitrate observed ~12 MB/s (~42 GB/hr) — budget disk accordingly.

## Immediate next steps (before ANY new features)

1. Wire Companion buttons (curl commands in README; see also the Companion wiring guide added in 84c8c58). Needs the user at the Stream Deck.
2. Auto-switch step 9 partial: rotation + kill switch verified live 2026-07-02; manual-override pause + audio-closeup rule not yet exercised against hardware (ATEM was powered off on 2026-07-04). Needs OBS open + ATEM powered on.
3. ~~NAS: set up SSH key auth, test sync~~ SUPERSEDED (2026-07-04): storage workflow is now T9 (record/cull) → manual export to NAS. `nas.enabled` stays `false` on purpose — step 11 of the manual test plan (auto-rsync) does not apply to this workflow and should be skipped, not fixed.
4. Consider switching OBS to Hybrid MP4 for chapter-marker support (see above). Needs OBS open — one settings toggle.
5. Log the first real recorded session — 0 of the 10 required for the V3 gate so far (hardware validation + smoke tests don't count as "sessions").

## Known gaps / small tickets (V2 polish)

- amaran lighting: NOT implemented. Blocked on the user's Sidus OpenAPI token (applied-for; takes days). When granted: `src/clients/amaran.ts` calling the local amaran Desktop OpenAPI, `lightingPreset` per profile already exists in config, apply on session start.
- ~~Companion feedback push~~ DONE (2026-07-02): `src/clients/companion.ts` pushes `orchestra_health` (`ok`/`fail`) to Companion custom variables on health-monitor transitions. Gated by `companion.enabled` in studio.yaml; needs Companion's HTTP API enabled. Fire-and-forget, 2s timeout, never affects the studio.
- ~~OBS chapter markers~~ DONE (2026-07-02): `/session/mark` also calls obs-websocket `CreateRecordChapter` (cleaner than the hotkey) while recording. Best-effort; needs OBS 30.2+ recording Hybrid MP4. Toggle: `obs.chapterMarkers` (default true).
- ~~launchd plist placeholder paths~~ DONE (2026-07-02): plist now points at `~/Documents/GitHub/ORCHESTRA` and node at `~/.local/node/bin/node` (verified via `which node` — homebrew node is NOT installed on this machine).

## V3 (GATED — do not start until 10+ clean real V2 sessions)

In order, from the original build plan (docs: studio-director-build-plan.md in the user's files):

- C1. OBS → RTSP/SRT feed reachable from the Jetson Orin AGX; measure latency.
- C2. `director-eyes` on Jetson (Python): person detection + shot scoring → MQTT `eyes/suggestion {cam, score, reason}` @ ~2 Hz.
- C3. mosquitto broker + policy engine in this daemon blending audio rules + vision suggestions + hysteresis. Kill switch stays on the Stream Deck.
- C4. Sony Camera Remote SDK wrapper (C++ → small binary the daemon shells to): record tally + Power Zoom presets on the 16-35 PZ (A7 IV first).
- C5. DJI RS4 gimbal spike, timeboxed 1 week: verify RS 4 (non-Pro) on the DJI R SDK supported list → CAN adapter + presets, else Intelligent Tracking Module. Do not extend the timebox.
- C6. Mission Control/Maestro integration: publish session events (started/ended/markers/paths) over MQTT; session metadata → Postgres on the NAS.

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
