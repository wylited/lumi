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
