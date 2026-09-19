'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CodeBlock,
  EmptyState,
  Input,
  KeyValue,
  LiveDot,
  Meter,
  Pill,
  Select,
  Sparkline,
  Stat,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  TierBadge,
  Timeline,
  Tr,
} from '@heli/ui'

const SERIES = [0.92, 0.95, 0.9, 0.97, 0.88, 0.3, 0.12, 0.18, 0.86, 0.94, 0.96, 0.91, 0.98, 0.93]

function Kit() {
  return (
    <div className="flex flex-col gap-10">
      <Row title="Button">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
        <Button size="sm">Small</Button>
      </Row>
      <Row title="Input · Select">
        <Input placeholder="Finish the problem set by 9" className="w-72" />
        <Select defaultValue="pomodoro_25_5" className="w-56">
          <option value="none">No breaks</option>
          <option value="pomodoro_25_5">25 / 5</option>
        </Select>
      </Row>
      <Row title="Pill · LiveDot">
        <Pill>neutral</Pill>
        <Pill tone="accent" dot>
          on task
        </Pill>
        <Pill tone="warn" dot>
          drifting
        </Pill>
        <Pill tone="danger">blocked</Pill>
        <LiveDot state="idle" />
        <LiveDot state="live" />
        <LiveDot state="speaking" />
      </Row>
      <Row title="TierBadge">
        {[0, 1, 2, 3, 4, 5].map((t) => (
          <TierBadge key={t} tier={t} />
        ))}
        {[0, 1, 2, 3, 4, 5].map((t) => (
          <TierBadge key={`c${t}`} tier={t} compact />
        ))}
      </Row>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardBody className="flex flex-col gap-5">
            <Stat label="Focused" value="34" unit="min" hint="of 40 in session" size="lg" />
            <Sparkline
              values={SERIES}
              threshold={0.7}
              label="On-task ratio"
              className="text-accent"
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-4">
            <Stat label="Off task" value="6" unit="min" />
            <Meter value={0.85} label="Focused share" />
            <Meter value={0.4} tone="warn" label="Nudge resolve rate" />
            <Meter value={0.1} tone="danger" label="Revert rate" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>KeyValue</CardTitle>
          </CardHeader>
          <CardBody>
            <KeyValue
              items={[
                { key: 'Min confidence', value: '0.70' },
                { key: 'Drift threshold', value: '30 s' },
                { key: 'Nudge gap', value: '3 min' },
                { key: 'Max tier', value: <TierBadge tier={3} compact /> },
              ]}
            />
          </CardBody>
        </Card>
      </div>
      <Row title="Table">
        <Table>
          <Thead>
            <Tr>
              <Th>Tier</Th>
              <Th>Resolved</Th>
              <Th>Ignored</Th>
            </Tr>
          </Thead>
          <Tbody>
            <Tr>
              <Td>
                <TierBadge tier={2} />
              </Td>
              <Td>4</Td>
              <Td>3</Td>
            </Tr>
            <Tr>
              <Td>
                <TierBadge tier={3} />
              </Td>
              <Td>5</Td>
              <Td>1</Td>
            </Tr>
          </Tbody>
        </Table>
      </Row>
      <div className="grid gap-4 md:grid-cols-2">
        <Timeline
          moments={[
            { id: '1', ts: '14:01', silent: true, tone: 'neutral' },
            { id: '2', ts: '14:02', silent: true, tone: 'neutral' },
            {
              id: '3',
              ts: '14:13',
              title: 'Drift noticed',
              tone: 'accent',
              meta: <TierBadge tier={1} />,
            },
            { id: '4', ts: '14:15', title: 'Nudge', tone: 'warn', meta: <TierBadge tier={2} /> },
            { id: '5', ts: '14:16', silent: true, tone: 'neutral' },
          ]}
        />
        <EmptyState title="Nothing yet. Start a session on the desktop and it shows up here." />
      </div>
      <CodeBlock code={`{ "tier": 2, "outcome": "resolved" }`} />
    </div>
  )
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-label uppercase text-text-faint">{title}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

export default function KitchenSink() {
  const [pinned, setPinned] = useState<'light' | 'dark'>('light')
  // Tokens resolve the theme on :root, so the whole page pins; the console panel stays dark.
  useEffect(() => {
    document.documentElement.dataset.theme = pinned
  }, [pinned])
  return (
    <main className="mx-auto max-w-[var(--max-content)] px-5 py-12">
      <div className="mb-10 flex items-end justify-between gap-6">
        <div>
          <span className="text-label uppercase text-text-faint">@heli/ui</span>
          <h1 className="text-display-2 font-semibold">Kitchen sink</h1>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPinned(pinned === 'light' ? 'dark' : 'light')}
        >
          Pin {pinned === 'light' ? 'dark' : 'light'}
        </Button>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-bg p-6 text-text">
          <Kit />
        </div>
        <div data-surface="console" className="rounded-lg border border-border bg-bg p-6 text-text">
          <Kit />
        </div>
      </div>
    </main>
  )
}
