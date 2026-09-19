# Lumi

<!--
  TODO(hero): one wide image, roughly 1600x900: the unit on a desk, the desktop app open behind
  it, the phone beside it. Save it as docs/media/hero.png. Material already in the tree: unit
  stills in apps/web/public/unit/, desktop screenshots in apps/web/public/shots/. No phone
  screenshot yet.
-->

![the desk robot](docs/media/hero.png)

Lumi is a desk robot that helps one person finish what they sat down to do. A camera on a robotic arm watches the desk and can turn to point at the page being worked on; a desktop app watches the computer; a phone app covers the hours away from both.

The desktop app reads the frontmost application, window titles, typing rate and idle time, never keystrokes or page contents. On Android the phone reads per-app time and unlock counts, and can send a blocked application to the Home screen with an Undo on the notification. iOS does not expose other applications' usage, so the app states what it cannot see.

When the work drifts from the goal, the system intervenes in steps: a colour on the tray icon, then a notification with an action on it, then a sentence spoken aloud, and only then a change to the computer itself, which the goal has to permit. Every change is shown in the app and reversed in one click.

## Implementation notes

`packages/contracts` is zod, compiled to TypeScript for the server and the clients and to JSON Schema for the rig, so the two sides cannot disagree without a test failing first. One arm has one driver at a time: `arm.aim`, `arm.point` and `arm.home` pause the pose tracker while they run. There is also no demo mode and no offline stand-in: without a DeepSeek key the server still serves HTTP and names the missing key.

## Running it

```bash
./scripts/demo.sh
```

It brings up Postgres and MinIO, applies the schema, seeds the user and the machine, starts the API, the storefront and the desktop app, and prints the URLs. Re-running it stops what it started previously. `./scripts/verify.sh` runs lint, typecheck and the tests, then checks the routes and both interfaces. Keys go in `apps/server/.env`, and only the server holds one.

## Repository layout

```
apps/edge            the rig. Python, camera, arm, speaker
apps/server          the aggregator. Fastify, Postgres, MinIO
apps/desktop         the app. Tauri 2 and React
apps/mobile          the phone. Expo
apps/web             the storefront. Next.js
packages/contracts   the schemas both languages share
```

`AGENTS.md` is the working agreement, `docs/00-architecture.md` has the drawings, and `docs/COMMITS.md` is the ledger.
