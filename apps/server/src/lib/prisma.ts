import { PrismaClient } from '@prisma/client'

/**
 * The one PrismaClient for this process.
 *
 * Every module that touches the database imports this instead of constructing
 * its own: each `new PrismaClient()` opens its own connection pool, and P1 lands
 * four or five modules that read or write rows. Route files are loaded by folder
 * at boot and are never unloaded, so there is nothing to tear down at shutdown
 * either — `app.close()` does not own this client and does not need to.
 *
 * Owned by HELI-011 and frozen after it, like every shared file in this repo.
 * It is the single path by which any later commit reaches Postgres.
 */
export const prisma = new PrismaClient()
