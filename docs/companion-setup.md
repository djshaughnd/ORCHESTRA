# Companion wiring — Stream Deck buttons for ORCHESTRA

Target: Bitfocus Companion on the Mac Studio, one page called **STUDIO**. Daemon at `http://127.0.0.1:8722`, ATEM at `192.168.1.99`, OBS WS at `127.0.0.1:4455`.

## 1. Connections (Companion → Connections tab)

| Connection | Module | Settings |
|---|---|---|
| `atem` | Blackmagic ATEM | IP `192.168.1.99` |
| `obs` | OBS Studio | `127.0.0.1:4455` + your WS password |
| `orchestra` | Generic HTTP | Base URL `http://127.0.0.1:8722` |

Also enable Companion's HTTP API (Settings → HTTP) — the daemon pushes health state to the custom variable `orchestra_health` (needs `companion.enabled: true` in studio.yaml).

Create the custom variable first: Variables → Custom, name `orchestra_health`, default `ok`.

## 2. Page layout

```
┌─────────┬─────────┬─────────┬─────────┐
│   GO    │  MARK   │   END   │ HEALTH  │
├─────────┼─────────┼─────────┼─────────┤
│  CAM 1  │  CAM 2  │  CAM 3  │  CAM 4  │
├─────────┼─────────┼─────────┼─────────┤
│AUTO ARM │AUTO KILL│ PODCAST │  MUSIC  │
└─────────┴─────────┴─────────┴─────────┘
```

## 3. Buttons

### GO (top-left, make it big)
Actions (in order, on press):
1. `orchestra`: HTTP POST — path `/session/start`, body `{"name":"session"}`, header `Content-Type: application/json`
2. Internal: Wait 500 ms
3. `orchestra`: HTTP POST — path `/record/start`
Feedback: `obs` → Recording active → red background.

### MARK
Action: `orchestra`: HTTP POST — path `/session/mark`, body `{"label":"mark"}`, header `Content-Type: application/json`.
(Also lands an OBS chapter marker when recording Hybrid MP4.)

### END
Action: `orchestra`: HTTP POST — path `/session/end`.
Stops recording, writes the manifest, fires NAS sync, disarms auto.

### HEALTH
No actions needed (display-only).
Feedback: Internal → variable check — `$(custom:orchestra_health)` equals `fail` → red background; otherwise green.
Button text: `HEALTH\n$(custom:orchestra_health)`.

### CAM 1–4
Action: `orchestra`: HTTP POST — path `/cut/1` (…/2, /3, /4).
Going through the daemon (not the ATEM module) makes manual cuts pause the auto-director. 
Feedback: `atem` → Program input matches (input 1–4) → yellow border.

> Fallback: duplicate this row on page 2 using the `atem` module's *Set input on Program* directly — those buttons work even if the daemon is down. Label the page **MANUAL (NO DAEMON)**.

### AUTO ARM
Action: `orchestra`: HTTP POST — path `/auto/arm`.
Style: white text on dark purple, text `AUTO\nARM`.

### AUTO KILL (kill switch — keep it adjacent to ARM, different color)
Action: `orchestra`: HTTP POST — path `/auto/disarm`.
Style: black on bright red, text `AUTO\nKILL`.

### PODCAST / MUSIC (profile select)
Action: `orchestra`: HTTP POST — path `/profile/podcast` (or `/profile/music`).
Add more as profiles grow (`/profile/dj`, `/profile/content`).

## 4. Sanity test after wiring

1. HEALTH button shows green (clear disk space first if red).
2. CAM 2 → program moves on the ATEM + yellow border follows.
3. GO → session folder appears, button turns red, OBS recording.
4. MARK twice, END → check `session.json` has 2 markers and a renamed take file.
5. AUTO ARM → cuts rotate; press CAM 1 → rotation pauses ~20s; AUTO KILL → stops.

## 5. Export when done

Companion → Import/Export → Export → commit the file to this repo under `companion/` so the button config is versioned with the code.
