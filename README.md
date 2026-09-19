# Lumi

<!--
  TODO(hero): one wide image, around 1600x900. The unit on a desk, the desktop app open behind it,
  the phone beside it. Save it as docs/media/hero.png and the line below starts working.

  Material already in the tree:
    apps/web/public/unit/    stills of the unit
    apps/web/public/shots/   desktop app screenshots, 2080x1360: goal, live, live-nudge, history
  No phone screenshot exists yet.
-->

![the desk robot](docs/media/hero.png)

A desk robot for one person trying to finish one thing. It watches you work, and when you drift away from the goal you set, it does something about it.

The camera is on a robotic arm, and that's the reason it can do more than record. The arm turns to point at the page you're stuck on, and it can follow you around the room instead of staring at an empty chair. There's a speaker for the moments when a notification isn't enough, and the frames it captures land on your own server.

The desktop app is where your goal lives, and it's the half that watches the computer: which app is in front, what the window title says, how much you're typing, whether you've gone idle. Counts and titles, never keystrokes, never the contents of a page. The live view fills in one minute at a time so you can watch it make up its mind.

Your phone covers the hours the desk can't see. On Android it reads app time and unlock counts, and if you open something the goal blocks it sends you Home with an undo sitting right there on the notification. iOS doesn't hand an app other apps' usage, so the phone tells you what it can't see instead of guessing.

## When you drift

Most minutes it does nothing, which is the point; a quiet session means it's working, not that it's asleep.

When it does act it starts small. The tray icon changes colour; if that doesn't bring you back, you get a notification with a button on it; after that it says a sentence out loud. Touching your computer is the last resort, and only where the goal allowed it. The app shows anything that changes your machine, undoes it in a click, and records what you did next. That last part is how `/v1/analytics/tiers` can tell you which channel actually works on you.

## Worth knowing

The boundary between TypeScript and Python is one file. `packages/contracts` is zod, compiled to TypeScript for the server and the apps and to JSON Schema for the rig, so the two sides can't quietly disagree; a drift turns up as a failing test instead of as a mystery in a socket.

One arm, one driver. `arm.aim`, `arm.point` and `arm.home` pause the pose tracker while they run, and the rig refuses to track while the operator console is driving the arm. Two things commanding one servo chain is the failure this avoids.

The tracker ignores anything under 4% of the frame, so a person sitting still doesn't get chased by a camera twitching at keypoint noise.

There's no demo mode and no offline stand-in, on purpose. Without a DeepSeek key the server still serves HTTP, and the log names the key it's missing.

## Running it

```bash
./scripts/demo.sh
```

It brings up Postgres and MinIO, pushes the schema, seeds the one user and the machine, starts the API, the storefront and the desktop app, then prints the URLs. Run it again whenever: it stops what it started last time rather than stacking up processes.

`./scripts/verify.sh` runs lint, typecheck and the tests, then hits the routes and checks both UIs. When a check can't run it exits 3 instead of 0, so a green result actually means something.

Keys go in `apps/server/.env`, and only the server holds one.

## Where things live

```
apps/edge            the rig. Python, camera, arm, speaker
apps/server          the aggregator. Fastify, Postgres, MinIO
apps/desktop         the app. Tauri 2 and React
apps/mobile          the phone. Expo
apps/web             the storefront. Next.js
packages/contracts   the schemas both languages share
```

The npm scope is still `@heli` and the repo is still called Helicopter; the product got a name and the packages didn't. `AGENTS.md` is the working agreement, `docs/00-architecture.md` has the drawings, and `docs/COMMITS.md` is the ledger.
