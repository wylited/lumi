import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiNudge } from '@heli/contracts'

import { createDeskSenders, noopSenders, type DeskSocket } from '../src/observe/outbound.js'

interface Sent {
  payloads: unknown[]
  binaries: Buffer[]
}

function fakeSocket(sent: Sent, withBinary = true): DeskSocket {
  return {
    send(payload) {
      sent.payloads.push(payload)
      return true
    },
    ...(withBinary
      ? {
          sendBinary(bytes: Buffer) {
            sent.binaries.push(bytes)
            return true
          },
        }
      : {}),
  }
}

const audioOut = {
  t: 'audio.out' as const,
  format: 'pcm_s16le' as const,
  sampleRate: 16_000,
  channels: 1,
  durationMs: 2_400,
  momentId: 'moment_1',
}

test('a spoken line goes down the desk socket, header first', () => {
  const sent: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({ desk: () => fakeSocket(sent) })

  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02, 1, 2, 3])), true)

  assert.equal(sent.payloads.length, 1)
  assert.deepEqual(sent.payloads[0], audioOut)
  assert.equal(sent.binaries.length, 1)
  assert.equal(sent.binaries[0]?.[0], 0x02, 'the audio tag leads the chunk')
})

test('a malformed audio.out is refused here, not by the desktop', () => {
  const sent: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({ desk: () => fakeSocket(sent) })

  // `channels: 0` is not a thing a speaker can play.
  assert.equal(senders.sendToSession('s1', { ...audioOut, channels: 0 }), false)
  assert.equal(sent.payloads.length, 0, 'nothing was handed to the socket')
})

test('a tier-2 nudge is a typed ApiNudge', () => {
  const sent: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({ desk: () => fakeSocket(sent) })

  assert.equal(senders.sendNotification('s1', 'Back to the problem set.'), true)
  const parsed = ApiNudge.safeParse(sent.payloads[0])
  assert.equal(parsed.success, true)
})

test('with nobody connected every sender refuses, and none throw', () => {
  const senders = createDeskSenders({ desk: () => null })
  assert.equal(senders.sendToSession('s1', audioOut), false)
  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02])), false)
  assert.equal(senders.sendNotification('s1', 'hello'), false)
})

test('a transport with no binary channel refuses audio but still sends JSON', () => {
  const sent: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({ desk: () => fakeSocket(sent, false) })

  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02])), false)
  assert.equal(sent.binaries.length, 0)
})

test('a lookup that throws is caught and reported as undelivered', () => {
  const senders = createDeskSenders({
    desk: () => {
      throw new Error('registry exploded')
    },
  })
  assert.equal(senders.sendToSession('s1', audioOut), false)
  assert.equal(senders.sendNotification('s1', 'hello'), false)
})

test('the no-op senders never claim to have delivered', () => {
  assert.equal(noopSenders.sendToSession('s1', audioOut), false)
  assert.equal(noopSenders.sendBinaryToSession?.('s1', Buffer.from([0x02])), false)
  assert.equal(noopSenders.sendNotification('s1', 'hello'), false)
})

/* ---- the phone, and the routing rule ------------------------------------- */

test('a spoken line follows the phone when motion says the person left the desk', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const phone: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => fakeSocket(desk),
    phone: () => fakeSocket(phone),
    away: () => true,
  })

  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02, 9])), true)

  assert.equal(desk.payloads.length, 0, 'the empty desk hears nothing')
  assert.equal(phone.payloads.length, 1)
  assert.equal(phone.binaries.length, 1)
})

test('a spoken line stays at the desk while the person is sitting there', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const phone: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => fakeSocket(desk),
    phone: () => fakeSocket(phone),
    away: () => false,
  })

  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(desk.payloads.length, 1)
  assert.equal(phone.payloads.length, 0)
})

test('a nudge prefers the phone, because it leaves the room with the person', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const phone: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => fakeSocket(desk),
    phone: () => fakeSocket(phone),
    away: () => false,
  })

  assert.equal(senders.sendNotification('s1', 'Back to it.'), true)
  assert.equal(phone.payloads.length, 1)
  assert.equal(desk.payloads.length, 0)
  assert.deepEqual(ApiNudge.safeParse(phone.payloads[0]).success, true)
})

test('nudges and speech fall back to the desk when no phone is paired', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({ desk: () => fakeSocket(desk), phone: () => null })

  assert.equal(senders.sendNotification('s1', 'Back to it.'), true)
  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(desk.payloads.length, 2)
})

test('an away phone that cannot carry audio refuses it rather than speaking to the empty desk', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const phone: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => fakeSocket(desk),
    phone: () => fakeSocket(phone, false),
    away: () => true,
  })

  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02, 1])), false)
  assert.equal(desk.binaries.length, 0)
  assert.equal(phone.binaries.length, 0)
})

test('tier 4 reaches the desktop as a contract-valid automation, and nowhere without one', async () => {
  const { ApiToDesktop } = await import('@heli/contracts')
  const { createDesktopAutomate } = await import('../src/observe/outbound.js')
  const sent: unknown[] = []
  const socket: DeskSocket = { send: (p) => (sent.push(p), true) }
  const automate = createDesktopAutomate((id) => (id === 'sess_1' ? socket : null))

  const input = { sessionId: 'sess_1', action: 'mute_site', target: 'instagram.com', message: 'Muted it.' }
  assert.equal(await automate(input), true)
  assert.equal(ApiToDesktop.safeParse(sent[0]).success, true)
  assert.deepEqual(sent[0], {
    t: 'automation',
    observationId: null,
    action: 'mute_site',
    target: 'instagram.com',
    message: 'Muted it.',
  })

  assert.equal(await automate({ ...input, sessionId: 'sess_2' }), false, 'no desktop, nothing changes')
  assert.equal(await automate({ ...input, action: 'format_disk' }), false, 'only the contract’s actions')
  assert.equal(sent.length, 1)
})

test('tier 4 acts on the top off-goal site, else the top off-goal app', async () => {
  const { offGoalTarget } = await import('../src/observe/index.js')
  const base = { topApps: [], topSites: [] } as unknown as Parameters<typeof offGoalTarget>[0]
  assert.equal(offGoalTarget(base), null)
  assert.equal(
    offGoalTarget({
      ...base,
      topApps: [
        { app: 'Code', seconds: 40, onTask: true },
        { app: 'Discord', seconds: 15, onTask: false },
      ],
    }),
    'Discord',
  )
  assert.equal(
    offGoalTarget({
      ...base,
      topApps: [{ app: 'Discord', seconds: 15, onTask: false }],
      topSites: [
        { title: 'youtube.com', seconds: 10, onTask: false },
        { title: 'instagram.com', seconds: 30, onTask: false },
      ],
    }),
    'instagram.com',
  )
})

test('a line speaks through the rig when no app is attached', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const rig: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => null,
    rig: () => fakeSocket(rig),
  })

  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02, 9, 9])), true)

  assert.equal(rig.payloads.length, 1, 'the header reached the rig')
  assert.equal(rig.binaries.length, 1, 'and so did the PCM')
  assert.equal(desk.payloads.length, 0)
})

test('the app speaks when both are attached, and the rig stays quiet', () => {
  const desk: Sent = { payloads: [], binaries: [] }
  const rig: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => fakeSocket(desk),
    rig: () => fakeSocket(rig),
  })

  assert.equal(senders.sendToSession('s1', audioOut), true)

  assert.equal(desk.payloads.length, 1, 'the app is the surface the person is looking at')
  assert.equal(rig.payloads.length, 0, 'one line, one speaker')
})

test('a rig that cannot carry audio still answers honestly rather than dropping the line', () => {
  const rig: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({
    desk: () => null,
    rig: () => fakeSocket(rig, false),
  })

  assert.equal(senders.sendToSession('s1', audioOut), true)
  assert.equal(senders.sendBinaryToSession?.('s1', Buffer.from([0x02, 1])), false)
})

test('a nudge is never handed to the rig, which cannot show one', () => {
  const rig: Sent = { payloads: [], binaries: [] }
  const senders = createDeskSenders({ desk: () => null, rig: () => fakeSocket(rig) })

  assert.equal(senders.sendNotification('s1', 'Back to the problem set.'), false)
  assert.equal(rig.payloads.length, 0, 'the rig has no notification surface')
})
