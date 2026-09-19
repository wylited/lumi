/**
 * The mock device — a fake Raspberry Pi, for developing and demoing with no
 * hardware, no camera, no microphone and no macOS permissions.
 *
 * This is the entry point `pnpm --filter @heli/server dev:mock` runs
 * (`package.json` → `node --import tsx src/dev/mock-device.ts`), and it drives
 * **both** fakes: the device below and `runDesktopMock` from `mock-desktop.js`.
 *
 * It speaks `docs/03-device-contract.md`, not a dialect of it:
 *
 *   - It pairs over `POST /v1/devices/pair` with the seeded code, then opens
 *     `/ws/device` with `Sec-WebSocket-Protocol: heli.v1, <deviceToken>` (§1).
 *   - Every frame it sends is validated against the contract's `DeviceToApi`
 *     before it goes on the wire, so a drift between this file and
 *     `packages/contracts` is an error here rather than a mystery in a socket.
 *   - It sends **four real JPEGs** from `apps/server/fixtures/frames/` — two over
 *     §5's untagged trigger path (`{t:'frame',seq,ts,trigger}` and then the raw
 *     JPEG, with nothing in between) and two over §6's tagged path (`0x01` plus
 *     the JPEG) after a `media.start` — so one run exercises both binary paths
 *     HELI-012 accepts.
 *   - It reports `hello` with caps that are actually true of a program with no
 *     camera, telemetry every ~5 s (§7), the state machine of §5, and the
 *     device's half of the spoken-line exchange (§6.3).
 *
 * `--speed` divides every duration and every timestamp by the multiplier. The
 * default is **1: the fixtures' real timings**, which is what the phase doc asks
 * for ("real signals at real timings") and what a demo should show. A
 * ten-minute scenario cannot be verified in a review, so `--speed 30` replays
 * the same timeline thirty times faster — the window the server then derives is
 * the fixture's numbers divided by thirty.
 */

import { ApiToDevice, DeviceToApi, MEDIA_TAG } from '@heli/contracts'
import type {
  ApiToDevice as ApiToDeviceMessage,
  DeviceCaps,
  PairDeviceResponse,
} from '@heli/contracts'
import type { Logger } from 'pino'

import { childLogger } from '../logger.js'
import {
  SCENARIOS,
  isAbort,
  helpText,
  openSocket,
  parseMockFlags,
  readFixtureFrame,
  request,
  runDesktopMock,
  sleep,
} from './mock-desktop.js'
import type { ScenarioName } from './mock-desktop.js'

/**
 * What this program can actually do — §4, "report what is actually true".
 *
 * `camera` is a string, and a mock's camera is not an IMX708: it is a folder of
 * fixture JPEGs and it says so. `mics: 0` and `audio: false` because it captures
 * no sound at all and never streams tagged `0x02`. `speaker: true` and
 * `shutter: true` are real: it consumes an `audio.out` header plus the tagged PCM
 * that follows and reports playback (§6.3), and it stops mid-stream when the
 * shutter is closed (§8). `ptz: false` because nothing here moves, which is what
 * §4 says the flag is for.
 */
const CAPS: DeviceCaps = {
  camera: 'mock-fixture-jpeg',
  mics: 0,
  speaker: true,
  shutter: true,
  ptz: false,
  transports: ['ws'],
  audio: false,
  resolutions: [[320, 240]],
  fps: [1, 5, 8],
}

/** §6.2's default video spec, narrowed to what the fixture frames really are. */
const VIDEO = { codec: 'jpeg', fps: 8, width: 320, height: 240 } as const

/**
 * `media.start` requires an audio spec (`MediaStart` has no "video only"
 * spelling) and §6.1's example announces both, so the format is announced even
 * though the mock's caps say it has no microphone and it sends no audio.
 * Announcing a format and sending nothing is the honest side of that shape; the
 * alternative is announcing a format the device does not have.
 */
const AUDIO = { codec: 'pcm_s16le', sampleRate: 16_000, channels: 1 } as const

/** The gap the mock leaves between triggers. Compressed by `--speed`. */
const TRIGGER_GAP_MS = 2_000

/** §7: telemetry every ~5 s while connected. A wall-clock cadence, never compressed. */
const TELEMETRY_MS = 5_000

/** How long a line takes to play, when the server ever sends one. Compressed by `--speed`. */
const LINE_MS = 1_200

interface DeviceMockOptions {
  url: string
  scenario: ScenarioName
  speed: number
  code: string
  log: Logger
  signal: AbortSignal
}

interface DeviceMockResult {
  deviceId: string
  sessionId: string | null
  frames: { seq: number; fixture: string; bytes: number; path: 'trigger' | 'tagged' }[]
  /** Error codes the server sent back, e.g. a rejected frame. */
  errors: string[]
}

type DeviceState = 'idle' | 'armed' | 'watching' | 'flagged' | 'speaking' | 'shutter_closed'

/** Polls a condition. `session.start` has no acknowledgement (§3), so this is how it is awaited. */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
  onTimeout: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(onTimeout)
    await sleep(25, signal)
  }
}

/**
 * The whole fake Pi: pair, connect, open a session, drive the desktop's replay
 * beside it, send four real frames down two binary paths, and close.
 */
export async function runDeviceMock(options: DeviceMockOptions): Promise<DeviceMockResult> {
  const { url, scenario, speed, code, log, signal } = options
  const plan = SCENARIOS[scenario]

  const paired = (await request(url, '/v1/devices/pair', {
    method: 'POST',
    body: { code },
  })) as PairDeviceResponse

  log.info(
    { url, scenario, speed, deviceId: paired.device.id, pairingCode: code },
    `paired with ${paired.device.name}; opening /ws/device`,
  )

  const socket = await openSocket(url, '/ws/device', paired.deviceToken, log, signal)

  let sessionId: string | null = null
  let sessionStarted = false
  let state: DeviceState = 'idle'
  let seq = 0
  let bytesSent = 0
  let mediaLive = false
  let shutterClosed = false
  let speakCommandId: string | null = null
  let pendingAudio: { durationMs: number; sampleRate: number; channels: number; momentId: string } | null =
    null
  let telemetry: ReturnType<typeof setInterval> | undefined
  const frames: DeviceMockResult['frames'] = []
  const errors: string[] = []

  const open = (): boolean => socket.readyState === 1

  const send = (message: unknown): void => {
    // The contract's own union is the last check before the wire. A mock that
    // speaks a dialect is worse than no mock: the demo proves the wrong thing.
    const validated = DeviceToApi.safeParse(message)
    if (!validated.success) {
      throw new Error(
        `the mock built a frame DeviceToApi rejects: ${
          validated.error.issues[0]?.message ?? 'invalid'
        }`,
      )
    }
    if (!open()) return
    const text = JSON.stringify(validated.data)
    bytesSent += Buffer.byteLength(text)
    socket.send(text)
  }

  const sendBytes = (bytes: Uint8Array): void => {
    if (!open()) return
    bytesSent += bytes.byteLength
    socket.send(bytes)
  }

  /* ---- the state machine (§5) -------------------------------------------- */

  const transition = (next: DeviceState, why: string): void => {
    if (next === state) return
    state = next
    send({ t: 'state', state: next })
    log.info({ state: next, why }, 'device state')
  }

  const ack = (commandId: string, status: 'done' | 'failed', result: Record<string, unknown>): void => {
    send({ t: 'command.ack', commandId, status, result })
  }

  /* ---- the inbound half: commands, policy, errors, and the line ----------- */

  /**
   * §6.3: `audio.out` is followed *immediately* by the tagged `0x02` PCM, and the
   * device plays it and reports the transition. Nothing in P1 sends one — see the
   * note at the spoken line below — but the path is implemented rather than
   * stubbed, so the day P2's loop speaks this is already the right device.
   */
  const finishLine = async (line: {
    durationMs: number
    momentId: string
  }): Promise<void> => {
    transition('speaking', 'playing the line the server sent')
    await sleep(Math.max(50, LINE_MS / speed), signal).catch(() => undefined)
    if (speakCommandId !== null) {
      ack(speakCommandId, 'done', { playedMs: line.durationMs, momentId: line.momentId })
      speakCommandId = null
    }
    transition('watching', 'the line finished playing')
  }

  const handleCommand = (command: ApiToDeviceMessage & { t: 'command' }): void => {
    const { id, type } = command
    log.info({ commandId: id, type }, 'device received a command')
    switch (type) {
      case 'identify':
        ack(id, 'done', { blinked: true })
        return
      case 'camera.ptz':
        // §4: `ptz: false` hides the controls, and §3 says to ack every command
        // including the ones you cannot perform.
        ack(id, 'failed', { reason: 'ptz cap is false; there is no head to move' })
        return
      case 'shutter.set': {
        shutterClosed = command.payload.closed
        if (shutterClosed && mediaLive) {
          // §8: within 200 ms, and nothing leaves the unit while it is closed.
          send({ t: 'media.stop', reason: 'shutter' })
          mediaLive = false
        }
        transition(shutterClosed ? 'shutter_closed' : 'watching', 'shutter.set')
        ack(id, 'done', { closed: shutterClosed })
        return
      }
      case 'speak':
        // The line arrives as `audio.out` + tagged PCM; this ack is the queue,
        // the played-in-full ack goes out from `finishLine`.
        speakCommandId = id
        ack(id, 'done', { queued: true })
        return
      case 'capture':
        ack(id, 'failed', { reason: 'the mock has no camera; it sends fixture frames on a timer' })
        return
      default:
        ack(id, 'done', {})
    }
  }

  const handleText = (text: string): void => {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      log.warn('the server sent something that is not JSON')
      return
    }
    const parsed = ApiToDevice.safeParse(json)
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues.slice(0, 3) },
        'the server sent a frame that is not ApiToDevice',
      )
      return
    }

    const message = parsed.data
    switch (message.t) {
      case 'session.start': {
        sessionId = message.sessionId
        sessionStarted = true
        log.info(
          {
            sessionId: message.sessionId,
            goal: message.goal.objective,
            blockedSites: message.goal.blockedSites,
            policy: { windowMs: message.policy.windowMs, maxTier: message.policy.maxTier },
          },
          'the server opened a session',
        )
        transition('watching', 'the session is live')
        return
      }
      case 'audio.out':
        pendingAudio = {
          durationMs: message.durationMs,
          sampleRate: message.sampleRate,
          channels: message.channels,
          momentId: message.momentId,
        }
        log.info(
          { momentId: message.momentId, durationMs: message.durationMs },
          'a line is coming; the PCM must follow immediately (§6.3)',
        )
        return
      case 'command':
        handleCommand(message)
        return
      case 'policy.update':
        log.info({ windowMs: message.windowMs }, 'policy updated mid-session')
        return
      case 'session.stop':
        log.info({ reason: message.reason }, 'the server stopped the session')
        return
      case 'error':
        errors.push(message.code)
        log.warn(
          { code: message.code, ref: message.ref, message: message.message },
          'the server refused a frame',
        )
    }
  }

  const handleBinary = (bytes: Uint8Array): void => {
    const tag = bytes[0]
    if (tag !== MEDIA_TAG.audio) {
      log.warn({ tag }, 'the server sent binary that is not the tagged audio of a line')
      return
    }
    const line = pendingAudio
    if (line === null) {
      log.warn('tagged audio arrived with no audio.out before it; dropping it')
      return
    }
    pendingAudio = null
    const pcm = bytes.subarray(1)
    const expected = Math.round((line.durationMs / 1000) * line.sampleRate * line.channels * 2)
    log.info(
      { momentId: line.momentId, bytes: pcm.byteLength, expectedBytes: expected },
      pcm.byteLength === expected
        ? 'the line is exactly durationMs of PCM at the announced format'
        : 'the line is not the length audio.out announced; playing what arrived',
    )
    void finishLine(line)
  }

  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      handleText(event.data)
      return
    }
    const view =
      event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : ArrayBuffer.isView(event.data)
          ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
          : null
    if (view === null) {
      log.warn('the server sent binary of a kind this mock cannot read')
      return
    }
    handleBinary(view)
  })

  /* ---- hello, and the session -------------------------------------------- */

  send({ t: 'hello', deviceId: paired.device.id, agentVersion: '0.1.0-mock', caps: CAPS })
  transition('armed', 'connected')
  send({ t: 'session.open', goalId: null })

  await waitFor(
    () => sessionStarted,
    10_000,
    signal,
    'the server never answered session.open — is the database seeded? ' +
      '(`pnpm --filter @heli/server db:seed`)',
  )

  /* ---- telemetry (§7) ----------------------------------------------------- */

  const startedAt = Date.now()
  telemetry = setInterval(() => {
    send({
      t: 'telemetry',
      cpu: 0.11,
      tempC: 44.5,
      rssi: -48,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      fps: mediaLive ? VIDEO.fps : 0,
      bytesSent,
    })
  }, TELEMETRY_MS)

  /* ---- the frames, down both binary paths -------------------------------- */

  const gap = (): Promise<void> => sleep(Math.max(150, TRIGGER_GAP_MS / speed), signal)
  const jpegs = await Promise.all(plan.frames.map((frame) => readFixtureFrame(frame.id)))

  /**
   * §5's path: the `frame` message, then the raw JPEG as the very next websocket
   * message. The server arms on the text frame and spends it on the next binary
   * one, so nothing may come between them — not even a state transition. The two
   * sends below are in the same tick, which is what makes that true.
   */
  const sendTriggerFrame = (index: number): void => {
    const frame = plan.frames[index]
    const jpeg = jpegs[index]
    if (frame === undefined || jpeg === undefined || shutterClosed) return
    seq += 1
    send({ t: 'frame', seq, ts: new Date().toISOString(), trigger: frame.trigger })
    sendBytes(jpeg)
    frames.push({ seq, fixture: frame.id, bytes: jpeg.byteLength, path: 'trigger' })
    log.info(
      { seq, trigger: frame.trigger, fixture: `${frame.id}.jpg`, bytes: jpeg.byteLength, path: '§5 untagged' },
      'sent a trigger frame',
    )
  }

  /** §6's path: a `media.start` in force, then `0x01` + the JPEG, tagged. */
  const sendTaggedFrame = (index: number): void => {
    const frame = plan.frames[index]
    const jpeg = jpegs[index]
    if (frame === undefined || jpeg === undefined || shutterClosed || !mediaLive) return
    seq += 1
    sendBytes(Buffer.concat([Buffer.from([MEDIA_TAG.video]), jpeg]))
    frames.push({ seq, fixture: frame.id, bytes: jpeg.byteLength, path: 'tagged' })
    log.info(
      { trigger: frame.trigger, fixture: `${frame.id}.jpg`, bytes: jpeg.byteLength, path: '§6 tagged 0x01' },
      'sent a media frame (the server assigns its own seq; tagged frames carry none)',
    )
  }

  /**
   * The desktop's replay runs beside the device's frames, in the same process,
   * against the same session: the desk and the machine are two halves of one
   * session, and starting them apart is what makes a demo show two sessions.
   */
  const desktop = runDesktopMock({
    url,
    scenario,
    speed,
    sessionId,
    log: childLogger({ module: 'mock.desktop' }),
    signal,
  })
  // Rejections are reported where the promise is awaited below; this stops an
  // early failure from surfacing as an unhandled rejection first.
  desktop.catch(() => undefined)

  sendTriggerFrame(0)
  await gap()
  sendTriggerFrame(1)

  if (scenario !== 'focused') {
    // The device's own read of the desk (§5): the scene changed and it does not
    // think this is work. The ring shows it; nothing is said out loud.
    transition('flagged', 'the last trigger did not look like work')
  }

  await gap()
  send({ t: 'media.start', video: VIDEO, audio: AUDIO })
  mediaLive = true
  await gap()
  sendTaggedFrame(2)
  await gap()
  sendTaggedFrame(3)
  await gap()

  send({ t: 'media.stop', reason: 'idle' })
  mediaLive = false
  transition('watching', 'media stopped')

  const replay = await desktop

  /* ---- a spoken line (§6.3) ---------------------------------------------- */

  /**
   * **What "a spoken line" means here.** A device can only *receive* a line: the
   * server sends `audio.out` and then the tagged `0x02` PCM, and the device plays
   * it and reports completion. Nothing in P1 produces an `audio.out` —
   * `voice/transport.ts` builds one, and the only thing that instantiates that
   * transport is `test/loop.test.ts`, because nothing outside `src/observe/`
   * imports the loop machinery in this folder at all (`grep -rn "observe/"
   * apps/server/src` finds type-only imports of `observe/types.ts` and nothing
   * else). So against a running server the inbound half cannot happen today; it
   * is implemented above anyway (`audio.out` → consume the PCM → `speaking` →
   * `watching` → `command.ack`) and will work unchanged the day P2 wires the
   * assessment loop into the boot path.
   *
   * What the mock can honestly *send* is the other end of that exchange:
   * `speaking` (a line is playing on this device), `bargein` (§2's "the person
   * spoke over us" — the one device→server message whose existence implies a line
   * was playing), and back to `watching`, which is the transition §6.3 requires
   * when playback stops. That triple is this mock's spoken line.
   */
  if (pendingAudio === null) {
    log.info(
      'no audio.out arrived, because no P1 code path sends one; reporting the local half of the line instead: speaking -> bargein -> watching',
    )
  }
  transition('speaking', 'a line is playing')
  await sleep(Math.max(150, LINE_MS / speed), signal)
  send({ t: 'bargein', ts: new Date().toISOString() })
  log.info('reported a barge-in: the person spoke over the line')
  transition('watching', 'playback stopped')

  if (telemetry !== undefined) clearInterval(telemetry)
  telemetry = undefined

  transition('idle', 'the scenario is over')

  log.info(
    {
      deviceId: paired.device.id,
      sessionId,
      scenario,
      speed,
      frames: frames.map((frame) => `${frame.fixture}.jpg seq=${frame.seq} (${frame.path})`),
      bytesSent,
      refusedFrameErrors: errors,
      desktop: {
        batches: replay.batches,
        signals: replay.signals,
        byTransport: { 'POST /v1/signals': replay.posted, '/ws/desktop': replay.socketed },
      },
    },
    'the run is over. The session is deliberately left OPEN: `session.close` calls endSignalSession, ' +
      'which empties the in-process signal ring, so the window this run produced would read null afterwards.',
  )

  if (open()) socket.close(1000, 'scenario finished')
  return { deviceId: paired.device.id, sessionId, frames, errors }
}

/* ---- the entry point ------------------------------------------------------ */

const log = childLogger({ module: 'mock' })

const main = async (): Promise<void> => {
  const flags = parseMockFlags(process.argv.slice(2))
  if (flags.help) {
    process.stdout.write(`${helpText()}\n`)
    return
  }

  const controller = new AbortController()
  process.once('SIGINT', () => {
    process.stdout.write('mock-device: interrupted, closing the socket\n')
    controller.abort()
  })
  // Nothing else may keep the process alive: the socket is closed by the runner
  // and every timer it started is cleared.
  process.once('SIGTERM', () => controller.abort())

  const result = await runDeviceMock({
    url: flags.url,
    scenario: flags.scenario,
    speed: flags.speed,
    code: flags.code,
    log: childLogger({ module: 'mock.device' }),
    signal: controller.signal,
  })

  log.info(
    {
      deviceId: result.deviceId,
      sessionId: result.sessionId,
      next: `curl -s "$HELI_URL/v1/sessions/${result.sessionId ?? '<id>'}/window" -H "authorization: Bearer $TOKEN"`,
    },
    'mock finished',
  )
}

main()
  .then(() => {
    // pino writes through a buffered destination; exiting without this can
    // truncate the last lines, which are the ones worth reading.
    log.flush()
    process.exit(0)
  })
  .catch((error: unknown) => {
    if (isAbort(error)) {
      process.stdout.write('mock-device: interrupted\n')
      process.exit(0)
    }
    process.stderr.write(`mock-device: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
