import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

/**
 * Routes are registered by folder, so every later commit in P1 adds one file
 * under `src/routes/` and touches nothing shared — no import list to edit, no
 * merge conflict between two people claiming two rows.
 *
 * A route file must:
 *   - live at `src/routes/<name>.ts`
 *   - `export default` a FastifyPluginAsync
 *   - optionally `export const prefix = '/v1/...'` if it wants a prefix
 *
 * It is registered at the root, so it declares its own full paths (`/v1/...`).
 * The folder loader tolerates `src/routes/` not existing yet.
 */
const ROUTES_DIR = new URL('../routes/', import.meta.url)

interface RouteModule {
  default?: FastifyPluginAsync
  prefix?: string
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  let files: string[]
  try {
    const entries = await readdir(ROUTES_DIR)
    files = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      app.log.info('No route files yet: src/routes/ does not exist.')
      return
    }
    throw error
  }

  for (const file of files) {
    const mod = (await import(new URL(file, ROUTES_DIR).href)) as RouteModule
    if (typeof mod.default !== 'function') {
      throw new Error(`src/routes/${file} must export default a fastify plugin.`)
    }
    await app.register(mod.default, mod.prefix ? { prefix: mod.prefix } : {})
  }

  app.log.info({ count: files.length, dir: fileURLToPath(ROUTES_DIR) }, 'routes registered')
}
