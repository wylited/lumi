import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * HELI-073 — the loop's line reaches the desktop.
 *
 * Two proofs. The first is the index's own semantics: newest socket wins, a
 * stale socket cannot evict its replacement, a detached session answers null.
 * The second opens a real `/ws/desktop`, says `hello` with a session id, and
 * then uses the loop's own lookup to send a nudge, an `audio.out` header and
 * the tagged PCM that follows it — in that order, which is the contract.
 */

// The server modules read env at import time and the test machine may have no
// .env at all (a clean clone). Set the two required values before importing.
process.env.DATABASE_URL ??= 'postgresql://heli:heli@localhost:5432/heli?schema=public'
process.env.JWT_SECRET ??= 'test-secret'
process.env.LOG_LEVEL ??= 'silent'

const { buildServer } = await import('../src/server.js')
const { signUserToken } = await import('../src/lib/jwt.js')
const { attachDesktopSocket, desktopSocketFor, detachDesktopSocket } = await import(
  '../src/ws/live-desktop.js'
)
const { MEDIA_TAG } = await import('@heli/contracts')

/** The shape the index stores: JSON out, binary out. */
interface FakeSocket {
  send(): boolean
  sendBinary(): boolean
}

const fakeSocket = (): FakeSocket => ({
  send: () => true,
  sendBinary: () => true,
})

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('the index answers with the newest socket per session, and only the live one', () => {
  const first = fakeSocket()
  const second = fakeSocket()

  attachDesktopSocket('s1', first)
  attachDesktopSocket('s2', fakeSocket())
  assert.equal(desktopSocketFor('s1'), first)
  assert.notEqual(desktopSocketFor('s2'), first)

  attachDesktopSocket('s1', second)
  assert.equal(desktopSocketFor('s1'), second)

  // A late close from a superseded socket must not evict its replacement.
  detachDesktopSocket('s1', first)
  assert.equal(desktopSocketFor('s1'), second)

  detachDesktopSocket('s1', second)
  assert.equal(desktopSocketFor('s1'), null)
  assert.equal(desktopSocketFor('never-attached'), null)
})

test('a live desktop is found by session and receives nudge, header and tagged PCM in order', async () => {
  const app = await buildServer()
  await app.listen({ port: 0, host: '127.0.0.1' })

  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  assert.ok(port > 0, 'the test server should have a port')

  const sessionId = 'session_live_desktop_test'
  const token = signUserToken('user_live_desktop_test')

  const received: Array<string | ArrayBuffer> = []
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/desktop`, ['heli.v1', token])
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('message', (event: MessageEvent) => {
    received.push(event.data as string | ArrayBuffer)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('the desktop socket failed')), {
        once: true,
      })
    })

    socket.send(JSON.stringify({ t: 'hello', appVersion: 'test', deviceId: null, sessionId }))
    await until(() => desktopSocketFor(sessionId) !== null)

    const live = desktopSocketFor(sessionId)
    assert.ok(live !== null)

    // The hello is answered with an ack, so it is frame zero.
    await until(() => received.length >= 1)
    assert.deepEqual(JSON.parse(received[0] as string), { t: 'ack', accepted: 0 })

    assert.equal(live.send({ t: 'nudge', observationId: null, message: 'Back to it.' }), true)
    assert.equal(
      live.send({
        t: 'audio.out',
        format: 'pcm_s16le',
        sampleRate: 24_000,
        channels: 1,
        durationMs: 120,
        momentId: 'moment_test',
      }),
      true,
    )
    const pcm = Buffer.from([1, 2, 3, 4])
    assert.equal(live.sendBinary(Buffer.concat([Buffer.from([MEDIA_TAG.audio]), pcm])), true)

    await until(() => received.length >= 4)
    assert.deepEqual(JSON.parse(received[1] as string), {
      t: 'nudge',
      observationId: null,
      message: 'Back to it.',
      action: null,
    })
    assert.equal(JSON.parse(received[2] as string).t, 'audio.out')
    const binary = Buffer.from(received[3] as ArrayBuffer)
    assert.equal(binary[0], MEDIA_TAG.audio)
    assert.deepEqual(binary.subarray(1), pcm)

    socket.close()
    await until(() => desktopSocketFor(sessionId) === null)
  } finally {
    socket.close()
    await app.close()
  }
})
