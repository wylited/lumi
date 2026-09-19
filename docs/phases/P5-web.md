# P5 · Web

**Goal:** the after-the-fact view — what happened, what the system did, what worked — plus the
landing page. Read-only over the session.

**Depends:** P0; `051` on P1/018; `054` on P1/011.
**Parallelism:** `050` first, then `051–054` are separate route folders and components; all parallel.
**Owner 3 · desktop + web** — the same person owns P3 and P5.

---

### HELI-050 · feat(web): next app shell
**Depends:** P0 **Parallel-safe:** no, blocks P5 **Owner:** 3
**Touches:** `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/kitchen-sink/**`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/components/shell/**`, `apps/web/lib/api.ts`, `apps/web/lib/format.ts`, `apps/web/.gitignore`
**Do:** Next 15 App Router. Tailwind v4 using `@heli/tokens` (`@theme inline`, so the role colours
follow the live theme). Import `tokens.css` and `tailwind.css` in the root layout. The two brand
fonts via `@fontsource-variable`. A `data-surface="console"` surface for anything dark-pinned.
```
**Done when:** a page rendering `<div className="bg-surface text-text">` picks up both themes, and
no raw hex exists in the app.

### HELI-051 · feat(web): analytics dashboard
**Depends:** 050, P1/018 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(app)/overview/**`, `apps/web/components/analytics/**`
**Do:** The home view: focused vs off-task time, the tier histogram **with outcomes** ("which
intervention actually gets you back"), top distractions ranked, a focus-by-hour heatmap, and the
longest focus run. Every figure tabular, one accent, no chart library — inline SVG. Honest empty
states when there is no data yet.
**Done when:** with the seeded history every panel renders real values and the tier table names the
most effective intervention.

### HELI-052 · feat(web): session replay
**Depends:** 050 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(app)/sessions/**`, `apps/web/components/session/**`
**Do:** A session reproduced after the fact: the timeline of windows, each with its assessment, the
tier that fired, the action, and the outcome; the interventions as cards; the frozen metrics. Silent
windows collapse to ticks on the rail — a run of ticks with one card is the whole story. Deep links
per observation.
**Done when:** a finished session is fully reviewable, offline from the device, and a silent run
reads as ticks rather than cards.

### HELI-053 · feat(web): landing page
**Depends:** 050 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(marketing)/**`, `apps/web/components/marketing/**`
**Do:** The pitch under the brief "Automate your studies / job / life": one hero that shows the
product doing something (the desk scene plus the live panel), how the loop works as a single
diagram, the tier model as a ladder, and one CTA. Short copy, concrete numbers, no adjectives doing
a number's job. Honest about privacy in one line.
**Done when:** a stranger understands in ten seconds that it acts, not just watches, and the page
passes Lighthouse 85 mobile.

### HELI-054 · feat(web): devices and pairing
**Depends:** 050, P1/011 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(app)/devices/**`, `apps/web/components/devices/**`
**Do:** List the desks and the desktop installs, their state and last seen, which goal they are
running, and the pairing code with a QR for the Pi. Rotate a code. A device detail with the live
feed (the media relay) and the command panel (capture, stream, led, identify), reusing the control
plane.
**Done when:** the QR pairs a device in one scan, rotating invalidates the old code, and the live
feed shows real frames.

### HELI-055 · feat(fixtures): contract-shaped demo data
**Depends:** 004 **Parallel-safe:** yes **Owner:** 3
**Touches:** `packages/fixtures/**`
**Do:** `@heli/fixtures` — every read the desktop and web make, as data that parses through the
`@heli/contracts` schemas: the seeded goal, the 40-minute study session (the same story as
`prisma/seed.ts`), a week of history, the analytics responses, the devices, and a live drift
generator that emits `LiveEvent`s. Both apps read through their `api` module, which falls back to
these when `NEXT_PUBLIC_HELI_API` / `VITE_HELI_API` is unset or the server is unreachable — so the
surfaces are demoable before P1 lands and after the wifi dies.
**Done when:** a test parses every fixture through its contract schema, and removing the server
leaves both apps fully populated.

---

## Exit criteria

- The dashboard answers "what actually gets me back on task" from real rows
- A session is fully reviewable without the device
- The landing page reads as a product that acts
