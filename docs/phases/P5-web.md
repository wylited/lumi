# P5 · Web — the storefront

**Goal:** the site a stranger lands on. It says what Helicopter does in ten seconds, sells the desk
unit, and hands out the desktop app. **The product is the desktop app and the device**; the web is
marketing only. It never reads or writes a session and never talks to the server.

**Depends:** P0, and real screens from P3 (the screenshots are of the actual app).
**Parallelism:** `050` first, then the pages are separate route folders; all parallel.
**Owner 3 · desktop + web.**

> **Decision (Sep 19).** The web started as an after-the-fact dashboard plus a landing page. The
> desktop's History does the dashboard's job better and is where people already are, so the review
> moved there (`038`), pairing moved there (`070`), and the web became the storefront. `051`, `052`
> and `054` are retired below rather than deleted, so the ledger keeps its history.

---

### HELI-050 · feat(web): next app shell
**Depends:** P0 **Parallel-safe:** no, blocks P5 **Owner:** 3
**Touches:** `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/components/shell/**`, `apps/web/app/kitchen-sink/**`, `apps/web/.gitignore`
**Do:** Next 15 App Router, Tailwind v4 on `@heli/tokens`, both brand fonts, light only.
**Done when:** a page renders with tokens only and no raw hex exists in the app.

### HELI-053 · feat(web): home page
**Depends:** 050 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(marketing)/page.tsx`, `apps/web/app/(marketing)/layout.tsx`, `apps/web/components/marketing/{Nav,Footer,MacWindow,SessionRibbon,Ladder}.tsx`, `apps/web/public/shots/**`
**Do:** One hero that shows the product pair — the desk unit in 3D beside a real screenshot of the
app mid-nudge. Then one session as a ribbon of minutes (the proof that silence is the default), the
escalation as a staircase, the two products side by side, privacy in one sentence, one close. Two
calls to action everywhere: order the unit, download the app.
**Done when:** a stranger can say in ten seconds that it acts rather than watches, and the page
passes Lighthouse 85 on mobile.

### HELI-056 · feat(web): the desk unit in 3D
**Depends:** 050 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/components/marketing/{DeviceScene,Unit}.tsx`
**Do:** The unit modelled from `docs/03-device-contract.md` in three.js, procedurally: body with the
24-dot ring, 4-mic top, down-firing speaker slot, yoke, tilting camera head, sliding shutter. The ring
follows the contract's table (one dim dot watching, voice-following while speaking, two amber dots
with the shutter closed, off when idle). Loaded lazily and client-only; pauses offscreen; honours
reduced motion; colours from `@heli/tokens`.
**Done when:** switching state changes the ring and the shutter exactly as the contract says, and
pages without the unit ship no three.js.

### HELI-057 · feat(web): device page
**Depends:** 056 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(marketing)/device/**`
**Do:** The unit with its states as a switch, the four parts and what each is for, what it never
does, specs from the contract, what is in the box, and a sticky buy bar.
**Done when:** every stated spec matches `docs/03-device-contract.md`.

### HELI-058 · feat(web): download page
**Depends:** 050, P3 screens **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(marketing)/download/**`
**Do:** Download for Apple silicon and Intel (`lib/product.ts`), requirements, setup in three steps
with real screenshots, and the three macOS permissions — what each reads and what it never reads.
**Done when:** the permission copy matches what the desktop's Settings says.

### HELI-059 · feat(web): order and reservations
**Depends:** 056 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(marketing)/order/**`, `apps/web/app/api/reserve/**`, `apps/web/components/marketing/ReserveForm.tsx`, `apps/web/lib/{product,reservation}.ts`
**Do:** Quantity, name, email, country, total, and one honest button: reserve, no payment now.
There is no billing in this project (AGENTS.md), so a reservation is validated with zod and appended
to `apps/web/.data/reservations.jsonl` (gitignored) and the person gets their place in line.
**Done when:** a reservation lands in the file, a bad email is refused with a readable message, and
nothing claims a payment happened.

### HELI-05A · feat(web): privacy page
**Depends:** 050 **Parallel-safe:** yes **Owner:** 3
**Touches:** `apps/web/app/(marketing)/privacy/**`
**Do:** What it reads, what it never reads, what it keeps, the shutter, what it may change on the
Mac, and where the model runs. Plain words, no legalese.
**Done when:** every claim on it is true of the code today.

---

### Retired

- **HELI-051 · analytics dashboard** — moved to the desktop's History (`038`).
- **HELI-052 · session replay** — moved to the desktop's History session sheet (`038`).
- **HELI-054 · devices and pairing** — moved to the desktop as `070`.

---

## Exit criteria

- Home, device, download, order and privacy are live, light, and pass Lighthouse 85 on mobile
- Every product claim matches the contract, the device contract, or the desktop's own copy
- The web has no server dependency: it builds and runs with the server down
