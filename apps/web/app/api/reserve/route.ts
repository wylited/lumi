import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { Reservation } from '@/lib/reservation'

// A reservation is a line in a file on this server: no payment, no account, nothing else stored.
const FILE = path.join(process.cwd(), '.data', 'reservations.jsonl')

export async function POST(req: Request) {
  const parsed = Reservation.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Check the form' }, { status: 400 })
  }
  await mkdir(path.dirname(FILE), { recursive: true })
  const existing = await readFile(FILE, 'utf8').catch(() => '')
  const position = existing.split('\n').filter(Boolean).length + 1
  await appendFile(FILE, `${JSON.stringify({ ...parsed.data, at: new Date().toISOString() })}\n`)
  return NextResponse.json({ position })
}
