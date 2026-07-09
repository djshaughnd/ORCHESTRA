# Stream Deck triggers — plugin-free, no browser, no Companion

The fastest, most robust way to drive ORCHESTRA from the **Elgato Stream Deck
app** you already run: tiny silent trigger apps, one per action, fired by the
Stream Deck's built-in **System → Open** action. No third-party plugin, no
Companion, no browser. Survives reboots. (Companion remains the richer option
if you later want buttons that change *color* on state — see
`companion-setup.md`.)

## Build the triggers

```bash
tools/build-streamdeck-triggers.sh
```

Creates these silent `.app`s in `~/Documents/ORCHESTRA-StreamDeck/` (each runs
one curl against the daemon at `127.0.0.1:8722` and quits invisibly):

| App | Fires | Does |
|---|---|---|
| `GO.app` | `POST /go {profile:dj, sequence:mixingReel}` | **one press = session + record + cinematic reel, hands-free** |
| `MARK.app` | `POST /session/mark` | timestamped marker (+ OBS chapter) |
| `END.app` | `POST /session/end` | stop record, write manifest, disarm |
| `CAM1-HERO.app` | `POST /cut/1` | cut to back-wall hero (aborts a running reel) |
| `CAM2-OVER.app` | `POST /cut/2` | cut to overhead |
| `REEL.app` | `POST /sequence/mixingReel/run` | run the reel without restarting the session |
| `KILL.app` | `POST /auto/disarm` | kill switch — stop any sequence instantly |

Re-run the script any time to rebuild (e.g. after changing the daemon port or
the GO profile/sequence). Verified live 2026-07-09: launching `CAM1-HERO.app` /
`CAM2-OVER.app` cuts the real ATEM program.

## Assign to keys (Elgato Stream Deck app, ~20s per button)

1. In the actions list (right side), open **System** and drag **Open** onto a key.
2. With that key selected, in the settings at the bottom set **App / File** to the
   matching app in `~/Documents/ORCHESTRA-StreamDeck/` (e.g. `GO.app`).
3. Set the **Title** (e.g. `GO`) and an icon if you like.
4. Repeat for the others. Suggested layout:

```
┌──────┬──────┬──────┬──────┐
│  GO  │ MARK │ END  │ KILL │
├──────┼──────┼──────┼──────┤
│ CAM1 │ CAM2 │ REEL │      │
│ hero │ over │      │      │
└──────┴──────┴──────┴──────┘
```

## Test

Press **GO** → a session folder appears on the T9, OBS starts recording, and the
reel cuts hero↔overhead on its own. Press **CAM1** → reel aborts, you're on hero.
Press **END** → recording stops, `session.json` written. Watch the capture light
on the dashboard (`http://127.0.0.1:8722/`) while it records.

## Why this over Companion (for now)

Companion (installed, see `companion-setup.md`) gives live button-color feedback
but its config lives in a browser admin UI. These triggers need nothing but the
Elgato app you already use, and they're dead simple and reboot-proof. Start here;
graduate to Companion when you want the color feedback.
