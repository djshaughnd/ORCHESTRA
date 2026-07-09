# ORCHESTRA — Claude Code project guide

Local studio-automation daemon for DICHEEKO Studio (Mac Studio + ATEM + OBS + Stream Deck). One button = studio recording. **Reliability > features, always.**

## Commands

- `npm test` — vitest (all tests must pass before any commit)
- `npm run typecheck` — tsc strict, no errors tolerated
- `npm run dev` — run daemon with reload
- `npm start` — run daemon foreground

## Stack (non-negotiable)

Node 20+, TypeScript strict ESM (NodeNext), Fastify, obs-websocket-js (v5), atem-connection, zod (config), pino (logging), vitest. No database — state in memory + JSON manifests on disk. No frontend framework — the dashboard is one inline HTML string (src/dashboard.ts).

## Architecture

- `src/index.ts` — boot + wiring only. No business logic.
- `src/config.ts` — zod schema for config/studio.yaml. ALL thresholds/settings live in studio.yaml, never hardcoded. Boot fails loudly on bad config.
- `src/session.ts` — SessionManager state machine + pure helpers (templating, markers). Pure functions exported for tests.
- `src/http.ts` — Fastify routes. Thin: parse/validate → call manager → respond.
- `src/clients/obs.ts` — OBS WS wrapper: auto-reconnect w/ backoff, fail-fast when down.
- `src/clients/atem.ts` — AtemClient interface; stub when atem.enabled=false.
- `src/switcher.ts` — AutoSwitchEngine (random rotation, pure, tick(nowMs)-driven, injectable RNG) + CueSequenceEngine (scripted cinematic cue lists, same tick-driven shape) + Director (owns ticker/lifecycle, holds whichever engine is active — mutually exclusive).
- `src/monitor.ts`, `src/health.ts`, `src/rename.ts`, `src/jobs/sync.ts` — self-explanatory.

## Hard rules (do not violate)

1. **Never block or gate StopRecord / session end on anything.** Stop always attempts, never 409s, never hangs.
2. **SIGTERM never stops a recording** — OBS outlives the daemon by design.
3. Manifest (`session.json`) is written BEFORE NAS sync fires. Sync is fire-and-forget with retries, never blocks HTTP.
4. Device commands fail fast with clear errors when a client is disconnected — an HTTP request must never hang on a dead device.
5. Auto-director is advisory plumbing: dead daemon → manual Companion buttons still work; manual cut always pauses auto mode.
6. Recording goes to LOCAL SSD only; NAS is post-session rsync. Never put the NAS in the live path.
7. Every device command logs at info with a `sessionId` correlation field.
8. New logic gets unit tests (pure functions preferred; mock clients like test/session-manager.test.ts does).

## Testing conventions

Engine/state-machine code must be clock-free and deterministic: drive via `tick(nowMs)` params and injected RNG, never `Date.now()` inside logic classes (Director is the only place that touches real time). See test/switcher.test.ts.

## Status

V1 + V2 complete. V3's 10-clean-session gate was explicitly overridden by the user on 2026-07-09 for a full cinematic-automation build (lighting + camera switching/settings + gimbal + storage, one Stream Deck button). See HANDOFF.md for full detail, current build state, and hardware SDK investigation findings (Sony/DJI/amaran).

## Docs

- `HANDOFF.md` — current state, open tickets, V3 plan. Update it when tickets complete.
- `docs/sdk-references.md` — external SDK links (Sony, DJI, etc.) with notes on which V3 tickets need them. Read before starting C4/C5.
