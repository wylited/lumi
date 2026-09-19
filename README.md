# Lumi

<!--
  TODO(hero): wide image, roughly 1600x900: the unit on a desk, the desktop app behind it, the
  phone beside it. Save as docs/media/hero.png. Stills already in the tree: apps/web/public/.
-->

![the desk robot](docs/media/hero.png)

Lumi helps one person finish what they sat down to do.

A camera on a robotic arm watches the desk and can turn to point at the page. A desktop app watches the computer, and a phone app covers the hours away.

When the work drifts from the goal it intervenes in steps: a tray colour, a notification, a sentence spoken aloud, and only then a change the app can reverse.

The desktop reads the frontmost application, window titles, typing rate and idle time. Never keystrokes or page contents.

On Android the phone reads per-app time and unlocks, and can send a blocked app Home with an Undo. iOS says what it cannot see.

## Implementation notes

`packages/contracts` is zod, compiled to TypeScript for the clients and to JSON Schema for the rig.

One arm has one driver: `arm.aim`, `arm.point` and `arm.home` pause the tracker while they run.

No demo mode and no offline stand-in. Without a DeepSeek key the log names the missing key.

## Running it

```bash
./scripts/demo.sh
```

Brings up Postgres and MinIO, seeds the user and the machine, starts the API, the storefront and the desktop app, and prints the URLs.

`./scripts/verify.sh` runs the gates and the route checks. Keys go in `apps/server/.env`.

## Repository layout

```
apps/edge            the rig. Python, camera, arm, speaker
apps/server          the aggregator. Fastify, Postgres, MinIO
apps/desktop         the app. Tauri 2 and React
apps/mobile          the phone. Expo
apps/web             the storefront. Next.js
packages/contracts   the schemas both languages share
```

`AGENTS.md` is the working agreement; `docs/00-architecture.md` has the drawings.
