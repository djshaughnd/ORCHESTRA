# SDK references (V3 research links)

Fetch these when the relevant ticket starts — do not pre-load or vendor SDKs into this repo.

## Needed for V3

- **Sony Camera Remote SDK** (ticket C4 — record tally, Power Zoom presets on the 16-35 PZ, A7 IV first):
  https://support.d-imaging.sony.co.jp/app/sdk/en/index.html
  C++ SDK, macOS supported. Plan: small wrapper binary the daemon shells out to. Verify A7C support on the current device list before promising anything beyond the A7 IV.

- **DJI RS SDK** (ticket C5 — gimbal spike, 1-week timebox):
  https://www.dji.com/rs-sdk
  First task of the spike is checking whether RS 4 (non-Pro) is on the supported-device list. If not: Intelligent Tracking Module instead, no code. Do not buy a CAN adapter before this check.

## Reference only (not needed for planned work)

- **OBS developer guide**: https://obsproject.com/kb/developer-guide — we already control OBS via obs-websocket v5 (`src/clients/obs.ts`). Only relevant if we ever write an OBS plugin, which nothing plans for.
- **obs-studio source**: https://github.com/obsproject/obs-studio — do NOT clone into this workspace; it's huge and unnecessary.
- **Blackmagic SDK page**: https://www.blackmagicdesign.com/developer/products/capture-and-playback/sdk-and-software — this is the DeckLink *capture card* SDK, not ATEM control (which `atem-connection` already handles). Only relevant if a capture card is added to the Jetson for C1.
- **Elgato Stream Deck SDK**: https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/ — intentionally unused. Bitfocus Companion owns the deck; a native plugin would put logic on the device, which violates the architecture (hardware is never the brain).
