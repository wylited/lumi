import { PrismaClient } from '@prisma/client'

/**
 * The bootstrap, not sample data: the one person and the one machine. Goals and
 * sessions come from using the app. Sessions still reference a `Device` row, so
 * the machine is one; the rig registers its own desk against this user.
 */
const prisma = new PrismaClient()

const USER_ID = 'user_seed'
const DEVICE_ID = 'dev_seed'

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: 'me@heli.local', name: 'Ari' },
    update: {},
  })

  await prisma.device.upsert({
    where: { id: DEVICE_ID },
    create: {
      id: DEVICE_ID,
      code: 'LUMI-ONE',
      name: 'Lumi One',
      caps: { camera: true, mic: true, speaker: true, led: true, ptz: false },
      state: 'idle',
      userId: user.id,
    },
    update: { code: 'LUMI-ONE', name: 'Lumi One', userId: user.id },
  })
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`seed failed: ${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
