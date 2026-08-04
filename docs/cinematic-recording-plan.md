# Cinematic recording plan — DICHEEKO studio

*Decided 2026-07-09 with Shaughn. The goal: walk in, hit one button, perform,
and walk out with a switched multi-angle "mini cinematic" reel — hands-free,
because you can't mix and ride the switcher at the same time.*

## The hardware reality that drives every decision

- **ATEM Mini Pro ISO** — switching is controlled by ORCHESTRA over **Ethernet**
  (`atem-connection`). This is independent of the USB-C port and already works.
  Verified 2026-07-09: daemon cuts `1→2→1`, the ATEM's own program state
  follows exactly, and OBS shows the switch live.
- **The single USB-C port is the constraint.** On the Mini Pro ISO the one
  USB-C is **either** webcam-out-to-computer **or** record-to-SSD — never both
  (confirmed on Blackmagic's forum). It currently goes to the Mac Studio.
- **Clean audio** comes from the **Apollo Twin X**, mapped inside OBS. Moving
  the USB-C to an SSD for ATEM ISO recording would strand that audio path.
- Conclusion: **OBS is the integration hub.** OBS records the switched program
  with clean Apollo audio; ORCHESTRA drives switching over Ethernet in parallel.
  The whole stack (OBS, Node/ORCHESTRA, atem-connection, obs-websocket) is
  cross-platform.

## Confirmed camera map (2026-07-09, by live cut test)

| ATEM input | Shot |
|---|---|
| CAM1 | back-wall wide **hero** (whole room + DJ booth) |
| CAM2 | **overhead** (top-down on the Pioneer decks) |
| CAM3 | *empty* — camera slider goes here |
| CAM4 | *empty* — DJI RS4 gimbal goes here |

## The four layers

**Layer 1 — Automated switching · ✅ DONE**
`CueSequenceEngine` in `src/switcher.ts` plays a scripted, timed cut list
(`sequences` in a profile). `POST /sequence/:name/run`. Verified live: cuts on
schedule, hands-free. The `dj` profile's `mixingReel` uses the two live cameras.

**Layer 2 — Recording via OBS · ✅ DONE (pre-existing)**
ORCHESTRA controls OBS record start/stop; OBS keeps the clean Apollo audio.
Ethernet switching and USB-C capture use different ports, so they coexist.

**Layer 3 — Capture reliability · ✅ built 2026-07-09 / 🔧 physical part ongoing**
The one real risk: the flaky Blackmagic UVC webcam capture freezing/dropping
mid-set (observed). Addressed by:
- **`CaptureWatchdog`** (`src/capture-watchdog.ts`): while recording, polls the
  OBS capture source (`GetSourceScreenshot` → frame hash) and, on a frozen or
  dropped feed, fires an **instant alert** (macOS notification + Companion
  `orchestra_capture` variable). Optional best-effort auto-recover
  (`obs.captureWatchdog.autoRecover`, default off). Verified live: no
  false-alarm on the moving feed, arms/disarms exactly with recording.
- **Physical (do at the desk):** direct USB-C↔USB-C to a Mac Studio port, no
  hub/adapter, quality cable; set the OBS source to match the ATEM (1080p30);
  uncheck "deactivate when not showing". When the UVC drops, recreate the
  capture *source* (delete + re-add) — re-selecting the same device in the
  dropdown is not enough.

**Layer 4 — One-button macro · ✅ built 2026-07-09**
`POST /go {name?, profile?, sequence?, record?}` = open session → start
recording → run the named sequence, in one call. Verified live: a single call
started session + recording + watchdog + `mixingReel` together. This is the
Stream Deck "GO" button.

## Resolution chain — the grain root cause (found 2026-08-04)

**The ATEM Mini Pro ISO is 1080p ONLY — it physically cannot pass 4K.** The
cameras shoot 4K, but everything downstream of the ATEM is 1920x1080.

A recording was found at **2160x3840 (vertical "4K")**: OBS was cropping a
~608x1080 slice out of the 1080p ATEM feed and upscaling it ~3.5x. That is
**FAKE 4K** — 0.65 MP of real detail smeared across an 8.3 MP frame, which
reads as heavy grain/mush no matter the bitrate (it was already 50 Mbps HEVC).
File cost: 2.7 GB for 7.6 minutes.

Fix applied: OBS canvas **1080x1920** (vertical 1080p reel), ScaleType
**lanczos** (sharper than bicubic), record bitrate 50 -> 25 Mbps (right-sized
for 1080p). Source framed with BOUNDS_SCALE_OUTER to fill 9:16 full-bleed.

**Ceiling to remember:** ANY vertical reel taken from the ATEM involves some
upscale, because a 9:16 crop of a 1080p landscape frame is only ~608 px wide.
Genuinely native vertical needs one of: rotate a camera 90 degrees; capture one
camera's 4K HDMI directly (bypassing the ATEM, losing switching); or shoot
landscape and crop vertical in post.

## Recommended hardware upgrade (phase 2, optional)

ATEM **HDMI out → Elgato Cam Link** (you already run Elgato). The HDMI-out feed
is rock-solid vs. the UVC webcam, *and* it frees the USB-C so an SSD can go on
the ATEM for ISO recording (all angles, bulletproof backup) — the best of both
worlds. Two purchases (capture + SSD); not required for the current build.

## Where the camera SDKs actually fit (NOT switching)

Switching between angles is 100% the ATEM's job and already works with no SDK.
The SDKs are a *different layer*, tracked separately:
- **Sony Camera Remote SDK** — ISO/aperture/record-trigger on the A7C + A7 IV
  (both confirmed supported). Needs the user to register + accept Sony's EULA.
- **DJI RS4 SDK** — gimbal moves/presets (CAN-bus path is risky; see
  `docs/sdk-references.md`). The gimbal works as a plain ATEM input regardless.
- **amaran lighting** — local OpenAPI via the installed amaran Desktop app.

See `docs/sdk-references.md` and HANDOFF.md for the full SDK investigation.

## Status snapshot (2026-07-09)

Built and tested: cue-sequencer, `/go` macro, capture watchdog. 65/65 unit
tests, typecheck clean, all verified live against the real OBS + ATEM. Next
physical steps: harden the USB capture cable/settings; wire a Stream Deck GO
button to `POST /go`; populate CAM3/CAM4 as the slider and gimbal come online.
