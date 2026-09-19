import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import { env, mediaEnabled } from '../env.js'
import { childLogger } from '../logger.js'

const log = childLogger({ module: 'storage' })

export type StorageBackend = 's3' | 'memory'

export interface ObjectBody {
  body: Uint8Array
  contentType: string
}

export interface ObjectRef {
  key: string
  contentType: string
  bytes: number
  backend: StorageBackend
}

export interface PutObjectInput {
  key: string
  body: Uint8Array
  contentType: string
}

/**
 * S3 when there is a bucket to write to and media is switched on, memory
 * otherwise. The memory backend is what makes the whole media path work on a
 * laptop with no MinIO running — which is the normal case for the desktop and
 * web teams, who develop against fixtures.
 */
export const storageBackend = (): StorageBackend =>
  mediaEnabled() && (env.S3_BUCKET ?? '').length > 0 ? 's3' : 'memory'

/* ---- s3 ------------------------------------------------------------------ */

let client: S3Client | null = null

const s3 = (): S3Client => {
  client ??= new S3Client({
    region: env.S3_REGION,
    // MinIO is not in AWS, so it needs an explicit endpoint and path-style
    // addressing (bucket in the path, not the hostname).
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  })
  return client
}

let bucketReady: Promise<void> | null = null

/**
 * Creates the bucket on first use. Memoised, including the failure: a broken
 * object store must not send every frame into a retry storm, and the memo is
 * dropped on failure so the next frame after an outage tries again.
 */
export function ensureBucket(): Promise<void> {
  if (storageBackend() === 'memory') return Promise.resolve()

  const bucket = env.S3_BUCKET
  if (!bucket) return Promise.resolve()

  bucketReady ??= (async (): Promise<void> => {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: bucket }))
    } catch {
      await s3().send(new CreateBucketCommand({ Bucket: bucket }))
      log.info({ bucket }, 'created the object store bucket')
    }
  })().catch((error: unknown) => {
    bucketReady = null
    throw error
  })

  return bucketReady
}

/* ---- memory -------------------------------------------------------------- */

/**
 * The in-memory backend is a real store, not a mock, so it needs a bound: the
 * dev default has no bucket, and an unbounded Map of JPEGs is a leak that only
 * shows up twenty minutes into a demo. 64 MB of frames is far more than the
 * latest-still use case needs and small enough to be harmless.
 */
const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024

const memory = new Map<string, ObjectBody & { bytes: number }>()
let memoryBytes = 0

const rememberInMemory = (key: string, value: ObjectBody): void => {
  const existing = memory.get(key)
  if (existing) memoryBytes -= existing.bytes

  memory.set(key, { ...value, bytes: value.body.byteLength })
  memoryBytes += value.body.byteLength

  // Map iteration is insertion-ordered, so the first key is the oldest frame.
  while (memoryBytes > MEMORY_BUDGET_BYTES && memory.size > 0) {
    const oldestKey = memory.keys().next()
    if (oldestKey.done === true) break
    const evicted = memory.get(oldestKey.value)
    memory.delete(oldestKey.value)
    memoryBytes -= evicted?.bytes ?? 0
  }
}

/** Number of objects the memory backend is holding. Diagnostics only. */
export const memoryObjectCount = (): number => memory.size

/* ---- the two calls the rest of the server makes -------------------------- */

export async function putObject(input: PutObjectInput): Promise<ObjectRef> {
  const { key, body, contentType } = input

  if (storageBackend() === 'memory') {
    rememberInMemory(key, { body, contentType })
  } else {
    await ensureBucket()
    await s3().send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    )
  }

  return { key, contentType, bytes: body.byteLength, backend: storageBackend() }
}

/**
 * Reads an object back. A key that is not there answers `null` rather than
 * throwing: `latestFrameRef` and the ring it came from go stale independently of
 * the store, and a missing still is a 404 for the caller to decide on, not an
 * exception to catch three frames up.
 */
export async function getObject(ref: ObjectRef | string): Promise<ObjectBody | null> {
  const key = typeof ref === 'string' ? ref : ref.key
  const contentType = typeof ref === 'string' ? 'application/octet-stream' : ref.contentType

  if (storageBackend() === 'memory') {
    const hit = memory.get(key)
    return hit ? { body: hit.body, contentType: hit.contentType } : null
  }

  try {
    const response = await s3().send(
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    )
    if (!response.Body) return null
    const body = await response.Body.transformToByteArray()
    return { body, contentType: response.ContentType ?? contentType }
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null
    throw error
  }
}

/** Drops the memoised bucket probe, so a test can re-run `ensureBucket`. */
export function resetStorage(): void {
  bucketReady = null
  memory.clear()
  memoryBytes = 0
}
