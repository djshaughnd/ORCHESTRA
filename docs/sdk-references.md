# SDK references (V3 research links)

Fetch these when the relevant ticket starts — do not pre-load or vendor SDKs into this repo.

**Status 2026-07-09: the V3 gate (10 clean sessions) was explicitly overridden by the user — see HANDOFF.md "V3 — GATE OVERRIDDEN 2026-07-09". Findings below are from that session's research.**

## Needed for V3

- **Sony Camera Remote SDK** (ticket C4 — record tally, Power Zoom presets, ISO/settings control):
  https://support.d-imaging.sony.co.jp/app/sdk/en/index.html
  C++ SDK, macOS supported. Plan: small wrapper binary the daemon shells out to.
  **CONFIRMED 2026-07-09**: both cameras on the rig — **Sony A7C and Sony A7 IV** — are on Sony's official Camera Remote SDK supported-device list (also FX3/FX30/FX6 etc., for future reference). Both need current firmware. Not yet done: registering a Sony developer account and accepting the SDK license agreement — that's a "accept terms" action the user needs to do themselves, not something to automate. Two cameras also means the daemon needs to manage two independent camera sessions, not one.

- **DJI RS SDK** (ticket C5 — gimbal, user explicitly wants SDK control pursued, not skipped, as of 2026-07-09):
  https://www.dji.com/rs-sdk
  **CONFIRMED RISKY 2026-07-09** (matches this doc's original caution): DJI's own forums show multiple reports of **no signal** over USB-CAN adapters trying to reach the RS4's CAN port, and DJI's downloads page reportedly serves the older RS2-era "R SDK" rather than a genuine RS4 SDK. User already owns the gimbal (bought specifically for SDK control) and wants the timeboxed spike run anyway (1 week, do not extend, fall back to manual/app-driven operation on failure — per the original plan). **DJI Ronin.app is already installed** on this Mac; check it for an official "request SDK/developer access" flow (parallel to amaran's, below) before attempting raw CAN-bus code blind. Treat the gimbal as a plain numbered ATEM camera input regardless of SDK outcome — that plumbing has no dependency on the SDK working.

## amaran lighting (not originally a V3 ticket — added 2026-07-09)

- **Local control, not the cloud OpenAPI**: `amaran Desktop.app` is already installed on this Mac and already has a working Elgato Stream Deck plugin (`com.amarancreators.controller.sdPlugin`), so lights are already manually controllable from the deck today, outside ORCHESTRA. HANDOFF previously assumed a mailed-in "Sidus OpenAPI token" was pending — checked Gmail, no such application was ever actually submitted.
- Official self-serve docs: https://tools.sidus.link/openapi/ (JS-rendered SPA, fetch tools return nothing useful — read it in an actual browser). Community reference implementation: https://github.com/theontho/amaran-cli (connects to the app's local WebSocket, port discovered via `lsof`, no token in its documented flow — but that may be a different, unauthenticated local surface than the "OpenAPI" access this doc originally meant; don't assume they're the same thing).
- **Investigated 2026-07-09**: launched the app, found it runs a local Python `websockets` server (ports `12345` and `33782` on this run — not fixed, discover via `lsof -nP -iTCP -sTCP:LISTEN | grep -i amaran`). Both ports are silent to blind unauthenticated probes. The sanctioned path is applying for OpenAPI/local-control access from inside the app's own Settings UI. **Blocked**: computer-use was locked by a concurrent Claude session when this was attempted — pick this up next by opening amaran Desktop and finding the access-request screen, then reading whatever local docs/token format it hands back. Do not reverse-engineer the raw WebSocket protocol blind.

## Reference only (not needed for planned work)

- **OBS developer guide**: https://obsproject.com/kb/developer-guide — we already control OBS via obs-websocket v5 (`src/clients/obs.ts`). Only relevant if we ever write an OBS plugin, which nothing plans for.
- **obs-studio source**: https://github.com/obsproject/obs-studio — do NOT clone into this workspace; it's huge and unnecessary.
- **Blackmagic SDK page**: https://www.blackmagicdesign.com/developer/products/capture-and-playback/sdk-and-software — this is the DeckLink *capture card* SDK, not ATEM control (which `atem-connection` already handles). Only relevant if a capture card is added to the Jetson for C1.
- **Elgato Stream Deck SDK**: https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/ — intentionally unused. Bitfocus Companion owns the deck; a native plugin would put logic on the device, which violates the architecture (hardware is never the brain).
