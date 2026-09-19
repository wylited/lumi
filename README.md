# Lumi

<!--
  TODO(hero): one wide image, approximately 1600x900. The unit on a desk, the desktop app open
  behind it, the phone beside it. Save it as docs/media/hero.png and the line below will render.

  Material already in the tree:
    apps/web/public/unit/    stills of the unit
    apps/web/public/shots/   desktop app screenshots, 2080x1360: goal, live, live-nudge, history
  No phone screenshot exists yet.
-->

![the desk robot](docs/media/hero.png)

Lumi is a desk robot that helps one person finish what they sat down to do. It observes the desk through a camera and the computer through a desktop app, with a phone app covering the hours spent away from both. When the work drifts away from the goal that was set, it intervenes.

The camera is mounted on a robotic arm, and the arm is what separates this from a webcam. It can turn to point at the page being worked on, and it can follow the person around the room rather than holding on an empty chair. A speaker carries the spoken reminders, and every frame it captures is stored on your own server.

The desktop app holds the goal and observes the computer: the frontmost application, the window title, how much typing is happening, and whether the machine has gone idle. It reads counts and titles, never keystrokes and never the contents of a page. The live view fills in one minute at a time, so each decision can be inspected as it is made.

The phone covers the hours the desk cannot see. On Android it reads per-app time and unlock counts, and an application the goal blocks is sent to the Home screen with an Undo on the notification for when the decision was wrong. iOS does not expose other applications' usage, so the app states what it cannot see rather than implying otherwise.

## Intervention

Most minutes produce nothing, and that is intended. A quiet session is evidence that the system is working, not that it has stopped paying attention.

When it does act, it begins quietly. The tray icon changes colour; if the drift continues, a notification arrives with an action attached to it; only after that does it speak a sentence aloud. Changing something on the computer is the last resort, and the goal must permit it. Anything that changes the machine is displayed in the app, reversed in one click, and recorded alongside what happened next, which is how `/v1/analytics/tiers` can report which channel actually resolves a drift.

## Implementation notes

The boundary between TypeScript and Python is a single file. `packages/contracts` is zod, compiled to TypeScript for the server and the clients and to JSON Schema for the rig, so the two sides cannot disagree without a test failing first.

One arm has one driver at a time. `arm.aim`, `arm.point` and `arm.home` pause the pose tracker for as long as they run, and the rig refuses to track while the operator console is driving the arm; two things commanding one servo chain is the failure this prevents.

The tracker ignores movement below 4% of the frame, so a person sitting still is not chased by a camera reacting to keypoint noise.

There is no demo mode and no offline stand-in. Without a DeepSeek key the server still serves HTTP, and the log names the key that is missing.

## Running it

```bash
./scripts/demo.sh
```

The script brings up Postgres and MinIO, applies the schema, seeds the single user and the machine, starts the API, the storefront and the desktop app, and prints the URLs. Re-running it is safe: it stops the processes it started previously instead of leaving duplicates behind.

`./scripts/verify.sh` runs lint, typecheck and the tests, then checks the routes and both interfaces. It exits 3 rather than 0 when a check cannot run, so a passing result means every check was actually performed.

Keys belong in `apps/server/.env`, and no component other than the server holds one.

## Repository layout

```
apps/edge            the rig. Python, camera, arm, speaker
apps/server          the aggregator. Fastify, Postgres, MinIO
apps/desktop         the app. Tauri 2 and React
apps/mobile          the phone. Expo
apps/web             the storefront. Next.js
packages/contracts   the schemas both languages share
```

The npm scope remains `@heli` and the repository is still named Helicopter; the product name changed and the packages did not. `AGENTS.md` is the working agreement, `docs/00-architecture.md` contains the drawings, and `docs/COMMITS.md` is the ledger.
