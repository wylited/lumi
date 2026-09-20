import type { Loop } from './index.js'

/**
 * Where the HTTP surface reaches the loop.
 *
 * The loop is built outside fastify (`src/index.ts`) and the survey route is
 * registered inside it, so the one thing they can share is a module-level handle —
 * the same shape `ws/live-desktop.ts` uses for the desktop socket: one process,
 * one owner, one reference, written by the boot and read by whoever asks.
 *
 * `null` is the honest answer before the boot has finished and when the loop could
 * not be built at all (no vision key): the manual route answers 503 for it rather
 * than pretending a sweep happened.
 */
let loop: Loop | null = null

export const attachLoop = (l: Loop | null): void => {
  loop = l
}

export const theLoop = (): Loop | null => loop
