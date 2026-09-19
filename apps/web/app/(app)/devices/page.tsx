import type { Metadata } from 'next'
import { EmptyState } from '@heli/ui'
import { DeviceRow } from '@/components/devices/DeviceRow'
import { Pairing } from '@/components/devices/Pairing'
import { qrSvg } from '@/components/devices/qr'
import { Page, PageHeader, Section } from '@/components/shell/Page'
import { api } from '@/lib/api'

export const metadata: Metadata = { title: 'Devices' }

export default async function Devices() {
  const [devices, goals, code] = await Promise.all([api.devices(), api.goals(), api.pairingCode()])
  const active = goals.find((g) => g.active) ?? null
  const first = devices[0]

  return (
    <Page>
      <PageHeader
        eyebrow="Hardware"
        title="Devices"
        lede="The desk units that watch for this goal. A unit only sends frames and sound; it never stores them and never calls a model."
      />
      <div className="flex flex-col gap-14">
        <Section
          title="Desks"
          aside={`${devices.filter((d) => d.online).length} of ${devices.length} online`}
        >
          {devices.length ? (
            <div className="flex flex-col gap-3">
              {devices.map((d) => (
                <DeviceRow key={d.id} device={d} goal={active} />
              ))}
            </div>
          ) : (
            <EmptyState title="No desk paired yet. Pair one with the code below." />
          )}
        </Section>
        {first ? (
          <Section title="Pair a desk" aside="heli.v1">
            <Pairing deviceId={first.id} code={code} qrSvg={await qrSvg(code)} renderQr={qrSvg} />
          </Section>
        ) : null}
      </div>
    </Page>
  )
}
