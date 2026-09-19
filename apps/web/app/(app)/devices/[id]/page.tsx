import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Card, CardBody, KeyValue, LiveDot, Pill } from '@heli/ui'
import { Commands } from '@/components/devices/Commands'
import { STATE } from '@/components/devices/state'
import { Page } from '@/components/shell/Page'
import { api, videoUrl } from '@/lib/api'
import { relative } from '@/lib/format'

export const metadata: Metadata = { title: 'Device' }

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [devices, sessions] = await Promise.all([api.devices(), api.sessions()])
  const device = devices.find((d) => d.id === id)
  if (!device) notFound()

  const live = sessions.find((s) => s.deviceId === id && s.endedAt === null) ?? null
  const feed = live ? await videoUrl(live.id) : null
  const state = device.state ? STATE[device.state] : null
  const caps = device.caps

  return (
    <Page>
      <Link href="/devices" className="text-small text-text-faint hover:text-text">
        ← Devices
      </Link>
      <div className="mb-10 mt-5 flex flex-wrap items-center gap-4">
        <h1 className="text-display-2 font-semibold text-text">{device.name}</h1>
        {state ? (
          <Pill tone={state.tone} dot>
            {state.label}
          </Pill>
        ) : null}
        <span className="text-small text-text-faint">
          {device.online ? 'online' : 'offline'}
          {device.lastSeenAt ? ` · seen ${relative(device.lastSeenAt)}` : ''}
        </span>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div
          data-surface="console"
          className="relative aspect-video overflow-hidden rounded-lg border border-border bg-bg text-text"
        >
          {feed ? (
            // An MJPEG stream is a never-ending image; next/image cannot hold it.
            <img
              src={feed}
              alt={`Live feed from ${device.name}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center">
              <div className="flex max-w-[36ch] flex-col items-center gap-3">
                <LiveDot state="idle" />
                <p className="text-body text-text-muted">
                  {device.state === 'shutter_closed'
                    ? 'The shutter is closed. No frames leave the unit.'
                    : live
                      ? 'The session is live, but the media relay is not streaming.'
                      : 'No live session on this desk. The feed appears when one starts.'}
                </p>
              </div>
            </div>
          )}
          {feed ? (
            <span className="absolute left-4 top-4 flex items-center gap-2 rounded-pill bg-bg/80 px-3 py-1 text-caption text-text backdrop-blur">
              <LiveDot state="live" /> live
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardBody className="flex flex-col gap-4">
              <span className="text-label uppercase text-text-faint">Control</span>
              <Commands deviceId={device.id} online={device.online} />
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex flex-col gap-4">
              <span className="text-label uppercase text-text-faint">The unit</span>
              <KeyValue
                items={[
                  { key: 'Camera', value: caps.camera },
                  {
                    key: 'Resolutions',
                    value: caps.resolutions.map(([, h]) => `${h}p`).join(' · ') || '—',
                  },
                  { key: 'Frame rates', value: caps.fps.join(' · ') || '—' },
                  { key: 'Microphones', value: String(caps.mics) },
                  { key: 'Speaker', value: caps.speaker ? 'yes' : 'no' },
                  { key: 'Shutter', value: caps.shutter ? 'mechanical' : 'none' },
                  { key: 'Transports', value: caps.transports.join(', ') },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </Page>
  )
}
