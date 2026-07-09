# Companion wiring — the pro-studio Stream Deck for ORCHESTRA

Bitfocus Companion is the broadcast-standard control surface. Unlike the plain
Elgato app, its buttons **change color to reflect live studio state** — the GO
key glows red while recording, a camera key lights when it's on program, and a
key turns red the instant the capture feed freezes mid-set. That live feedback
is the point.

Target: Companion on the Mac Studio, one page **STUDIO** (+ a **MANUAL** fallback
page). Daemon `http://127.0.0.1:8722`, ATEM `192.168.1.99`, OBS WS `127.0.0.1:4455`.

Confirmed camera map (2026-07-09): **CAM1 = back-wall hero**, **CAM2 = overhead**.
CAM3/CAM4 reserved for the slider + gimbal.

## 0. Install (one-time)

Download Companion from **https://bitfocus.io/companion** (free, open source),
launch it, open the admin UI at `http://127.0.0.1:8000`, and add your Stream
Deck under **Surfaces**. Enable the HTTP API under **Settings → HTTP**.

ORCHESTRA is already configured to push to Companion (`companion.enabled: true`,
`url: http://127.0.0.1:8000` in studio.yaml). Nothing else to do on the daemon.

## 1. Connections (Companion → Connections)

| Connection | Module | Settings |
|---|---|---|
| `orchestra` | Generic HTTP | Base URL `http://127.0.0.1:8722` |
| `atem` | Blackmagic ATEM | IP `192.168.1.99` (feedback + manual fallback) |
| `obs` | OBS Studio | `127.0.0.1:4455` + your WS password (record feedback) |

## 2. Custom variables (Variables → Custom)

| Name | Default | Pushed by the daemon on… |
|---|---|---|
| `orchestra_health` | `ok` | every health-monitor transition (`ok`/`fail`) |
| `orchestra_capture` | `ok` | capture watchdog freeze/recover (`ok`/`frozen`) |

## 3. Page layout — STUDIO

```
┌─────────┬─────────┬─────────┬─────────┐
│   GO    │  MARK   │   END   │ CAPTURE │   ← GO runs the reel hands-free
├─────────┼─────────┼─────────┼─────────┤
│ CAM 1   │ CAM 2   │ CAM 3   │ CAM 4   │   ← 1 hero · 2 overhead
│ hero    │overhead │ slider  │ gimbal  │
├─────────┼─────────┼─────────┼─────────┤
│  REEL   │AUTO KILL│ HEALTH  │  DJ     │   ← KILL always adjacent, bright red
└─────────┴─────────┴─────────┴─────────┘
```

## 4. Buttons

### GO — one press = session + record + cinematic reel (make it big, top-left)
Action (single): `orchestra` HTTP **POST** `/go`
body `{"profile":"dj","sequence":"mixingReel"}`, header `Content-Type: application/json`.
That one call opens the session, starts recording, and runs the timed multi-cam
reel — hands-free while you perform.
Feedback: `obs` → *Recording active* → **red background**. Text `GO\n▶`.

> Want GO to record without auto-switching (you'll cut manually)? Drop
> `"sequence"` from the body. Want it not to record, just switch? add `"record":false`.

### MARK
Action: `orchestra` HTTP POST `/session/mark` body `{"label":"mark"}` + JSON header.
Also drops an OBS chapter marker when recording Hybrid MP4.

### END
Action: `orchestra` HTTP POST `/session/end`.
Stops recording, writes `session.json`, disarms the sequence, stops the watchdog.

### CAPTURE — the "did the feed freeze?" indicator (display-only)
No action. Feedback: Internal → *variable value* — `$(custom:orchestra_capture)`
equals `frozen` → **flashing red background**; else dark green.
Text: `CAPTURE\n$(custom:orchestra_capture)`. This is your mid-set safety light —
if the Blackmagic USB feed drops, this key goes red within ~4s.

### CAM 1–4 (route through the daemon, not the ATEM module)
Action: `orchestra` HTTP POST `/cut/1` (…`/2`, `/3`, `/4`).
Going through the daemon means a manual cut **aborts a running reel** (you take
over). Feedback: `atem` → *Program input is 1* (…2/3/4) → **yellow border**.
Label with the shot: `CAM 1\nHERO`, `CAM 2\nOVERHEAD`.

### REEL — run the cinematic sequence without (re)starting a session
Action: `orchestra` HTTP POST `/sequence/mixingReel/run`.
Use when you're already recording and just want to trigger the reel.
Feedback: Internal → `$(custom nothing)`; optional: `atem` program border.

### AUTO KILL (kill switch — keep it next to REEL, unmistakable color)
Action: `orchestra` HTTP POST `/auto/disarm`. Style: black on bright red, `AUTO\nKILL`.
Stops any running sequence/auto-switch instantly. Always works.

### HEALTH (display-only)
Feedback: Internal → variable value — `$(custom:orchestra_health)` equals `fail`
→ red; else green. Text `HEALTH\n$(custom:orchestra_health)`.

### DJ (profile select — add PODCAST/MUSIC/CONTENT as needed)
Action: `orchestra` HTTP POST `/profile/dj`.

## 5. MANUAL page (fallback — works even if the daemon is down)

Duplicate the CAM row using the **`atem` module's *Set input on Program*** directly
(not the daemon). Label the page **MANUAL (NO DAEMON)**. If ORCHESTRA ever
crashes mid-shoot, you still cut cameras straight on the ATEM. This is the
"hardware is never fully dependent on the brain" guarantee.

## 6. Sanity test after wiring

1. HEALTH green, CAPTURE green (clear disk if HEALTH is red).
2. CAM 2 → ATEM program moves to overhead + yellow border follows.
3. GO → session folder appears, GO turns red, OBS records, the reel starts
   cutting hero↔overhead on its own. Let it run; press CAM 1 → reel aborts,
   you're on hero. END → `session.json` written.
4. Freeze test: mid-record, pull the ATEM USB a second → CAPTURE goes red +
   macOS notification; replug → back to green.

## 7. Version the config

Companion → Import/Export → Export the STUDIO page, commit it under
`companion/` in this repo so the button layout is versioned with the code.
