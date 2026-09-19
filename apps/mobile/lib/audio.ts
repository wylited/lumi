import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import * as FileSystem from 'expo-file-system/legacy'

import type { AudioOut } from '@heli/contracts'

/**
 * A spoken line, from the same tagged PCM the rig and the desktop receive.
 *
 * React Native cannot hand raw samples to a speaker, so the tagged frame becomes
 * a WAV file in the cache and the file is played. The tag byte is verified
 * before anything is written: a binary frame without `MEDIA_TAG.audio` in front
 * of an `audio.out` header is not a line, and playing it would be a different
 * sound than the tutor decided on.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += ALPHABET[a >> 2]
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : ALPHABET[c & 0x3f]
  }
  return out
}

/** 44-byte RIFF/WAVE header around S16LE PCM. */
function wavBytes(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

interface CurrentLine {
  player: AudioPlayer
  uri: string
  finished: () => void
}

let current: CurrentLine | null = null

export function isLinePlaying(): boolean {
  return current !== null
}

/** Barge-in: the next line, or the person's hand, stops this one. */
export function stopLine(): void {
  if (current === null) return
  const { player, uri, finished } = current
  current = null
  try {
    player.pause()
    player.remove()
  } catch {
    // The player is already gone; the file below still needs cleaning.
  }
  void FileSystem.deleteAsync(uri, { idempotent: true })
  finished()
}

/**
 * Plays one tagged line. Resolves once playback has started; the promise the
 * caller waits on for "the line was spoken" is the ack from the radio, not the
 * speaker — this phone cannot acknowledge audio the way the rig does.
 */
export async function playLine(
  header: AudioOut,
  tagged: Uint8Array,
  onFinished: () => void,
): Promise<void> {
  stopLine()

  const pcm = tagged.subarray(1)
  if (pcm.byteLength === 0) return

  const uri = `${FileSystem.cacheDirectory ?? ''}lumi-line-${Date.now()}.wav`
  await FileSystem.writeAsStringAsync(uri, toBase64(wavBytes(pcm, header.sampleRate, header.channels)), {
    encoding: FileSystem.EncodingType.Base64,
  })

  const player = createAudioPlayer({ uri })
  const line: CurrentLine = { player, uri, finished: onFinished }
  current = line

  player.addListener('playbackStatusUpdate', (status) => {
    if (current !== line) return
    if (status.didJustFinish) {
      current = null
      try {
        player.remove()
      } catch {
        // Already released.
      }
      void FileSystem.deleteAsync(uri, { idempotent: true })
      onFinished()
    }
  })

  player.play()
}
