import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

/**
 * Route files are registered by folder, so every later commit in P1 adds one
 * file and touches nothing shared — no import list to edit, no merge conflict
 * between two people claiming two rows.
 *
 * Two folders are scanned:
 *   - `src/routes/`  HTTP routes
 *   - `src/ws/`      websocket routes (`{ websocket: true }`)
 *
 * A route file must:
 *   - live at `src/routes/<name>.ts` or `src/ws/<name>.ts`
 *   - `export default` a FastifyPluginAsync
 *   - optionally `export const prefix = '/v1/...'` if it wants a prefix
 *
 * It is registered at the root, so it declares its own full paths (`/v1/...`,
 * `/ws/...`). A folder that does not exist yet is skipped.
 */
const ROUTE_DIRS = [
  fileURLToPath(new URL('../routes/', import.meta.url)),
  fileURLToPath(new URL('../ws/', import.meta.url)),
]

interface RouteModule {
  default?: FastifyPluginAsync
  prefix?: string
}

async function routeFilesIn(dir: string, app: FastifyInstance): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort()
      .map((name) => join(dir, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      app.log.info({ dir }, 'no route files in this folder yet')
      return []
    }
    throw error
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  let count = 0

  for (const dir of ROUTE_DIRS) {
    for (const file of await routeFilesIn(dir, app)) {
      const mod = (await import(pathToFileURL(file).href)) as RouteModule
      if (typeof mod.default !== 'function') {
        throw new Error(`${relative(process.cwd(), file)} must export default a fastify plugin.`)
      }
      await app.register(mod.default, mod.prefix ? { prefix: mod.prefix } : {})
      count += 1
    }
  }

  app.log.info({ count }, 'routes registered')
}
