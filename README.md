# Lumi

<!--
  TODO(hero): wide image that showcases our desktop and mobile app @cedric.
-->

Lumi makes you finish what you sat down to do, automating your helicopter mom.

A camera on a robotic arm watches you and your desk. A desktop app observes your computer, and a phone app covers the rest.

When the work drifts from the goal it intervenes in steps: a tray colour, a notification, a sentence spoken aloud, or directly closing the distraction.

It tracks your progress over time and keeps you accountable for the work you did, and didn't do.

## How it works

Lumi processes multiple data points, a camera view, your screen data, open apps & tabs, and your phone activity, through DeepSeek vision, to conduct behavioural analysis and tracking of your focus and lack thereof.

Frames, signals and decisions live on your own server: your Postgres, your object store. The unit keeps nothing.

Assessment is the only call that leaves your machine. The frame goes to DeepSeek vision, comes back as a verdict, and DeepSeek retains nothing.

The robotic arm? Well, not all work happens statically; the SO101 arm empowers us to pan and tilt the camera around the workspace and track the user, and their environment, as they work.

## Running it

```bash
./scripts/demo.sh
```

One command for the whole stack: Postgres, MinIO, the schema, the seed, the API, the storefront and the desktop app, with the URLs printed at the end.

`./scripts/verify.sh` runs the gates and the route checks. Keys go in `apps/server/.env` and nowhere else. There is no demo mode: without a DeepSeek key the server still boots and names the key it wants.

## Layout

```
apps/edge            the rig. Python, camera, arm, speaker
apps/server          the aggregator. Fastify, Postgres, MinIO
apps/desktop         the app. Tauri 2 and React
apps/mobile          the phone. Expo
apps/web             the storefront. Next.js
packages/contracts   the schemas both languages share
```

`AGENTS.md` is the working agreement; `docs/00-architecture.md` has the drawings.
