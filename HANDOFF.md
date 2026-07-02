# HANDOFF — state and next work

*Last updated: 2026-07-02. Built in Cowork; handed off to Claude Code.*

## Where things stand

**V1 + V2 are code-complete, tested (42/42), typecheck clean, pushed to main.**

Working today: session lifecycle (`/session/start|mark|end`), record control, health checks + 30s monitor with macOS notifications, NAS rsync with retries, profile system (podcast/music/dj/content in studio.yaml), ATEM client (atem-connection, behind `atem.enabled` flag), rule-based auto-switching (rotation + manual-override pause + kill switch), audio-reactive closeup cuts (OBS InputVolumeMeters), take auto-renaming, dashboard at `GET /`.

**Not yet validated against real hardware.** Nothing has run against a real ATEM or a real multi-take session yet.

## Immediate next steps (before ANY new features)

1. Walk the user through the manual test plan in README.md with OBS open — fix whatever it shakes out.
2. First real-hardware checks: ATEM model confirmation (Ethernet? ISO?), `atem.enabled: true` smoke test (`POST /cut/2`), auto-switch dry run.
3. Help the user wire Companion buttons (curl commands in README).

## Known gaps / small tickets (V2 polish)

- amaran lighting: NOT implemented. Blocked on the user's Sidus OpenAPI token (applied-for; takes days). When granted: `src/clients/amaran.ts` calling the local amaran Desktop OpenAPI, `lightingPreset` per profile already exists in config, apply on session start.
- Companion feedback push: `/health` polling works, but consider pushing state to Companion's HTTP API to flip button colors on failures.
- OBS chapter markers (OBS 30.2+ Hybrid MP4): `/session/mark` could also fire the OBS chapter-marker hotkey.
- launchd plist has placeholder paths (`~/studio/orchestra`) — repo actually lives at `~/Documents/GitHub/ORCHESTRA`; fix before installing the service.

## V3 (GATED — do not start until 10+ clean real V2 sessions)

In order, from the original build plan (docs: studio-director-build-plan.md in the user's files):

- C1. OBS → RTSP/SRT feed reachable from the Jetson Orin AGX; measure latency.
- C2. `director-eyes` on Jetson (Python): person detection + shot scoring → MQTT `eyes/suggestion {cam, score, reason}` @ ~2 Hz.
- C3. mosquitto broker + policy engine in this daemon blending audio rules + vision suggestions + hysteresis. Kill switch stays on the Stream Deck.
- C4. Sony Camera Remote SDK wrapper (C++ → small binary the daemon shells to): record tally + Power Zoom presets on the 16-35 PZ (A7 IV first).
- C5. DJI RS4 gimbal spike, timeboxed 1 week: verify RS 4 (non-Pro) on the DJI R SDK supported list → CAN adapter + presets, else Intelligent Tracking Module. Do not extend the timebox.
- C6. Mission Control/Maestro integration: publish session events (started/ended/markers/paths) over MQTT; session metadata → Postgres on the NAS.

## Context the code can't tell you

- The user (Shaughn) runs DICHEEKO Studio; this ties into a broader "Mission Control / Brain Router" architecture later — `orchestra` should stay a clean standalone service it can talk to.
- Original architecture decision: Companion is the glue for V1 hardware control; the daemon is the single source of truth for state; hardware is never the brain; Jetson (V3) only *suggests* cuts over MQTT.
- Recording locally then syncing exists because a network hiccup mid-take is unacceptable (hard-learned lesson).
