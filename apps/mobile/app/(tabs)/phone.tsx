import { View } from 'react-native'
import Svg, { Rect } from 'react-native-svg'

import { radius, space } from '@heli/tokens'

import { Monogram, Page, Section } from '@/components/kit'
import { Button, Text } from '@/components/ui'
import { dur } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useTheme } from '@/lib/theme'
import { openUsageSettings } from '@/lib/usage'

const MOTION: Record<string, string> = {
  still: 'Still',
  walking: 'Walking',
  running: 'Running',
  driving: 'Driving',
  unknown: 'Not reporting',
}

/** Phone: what this session looked like on the phone — the total, the apps, the unlocks. */
export default function Phone() {
  const t = useTheme()
  const { view, grants, android } = useLive()
  const session = view?.data.session ?? null
  const phone = view?.phone ?? null
  const motion = view?.data.phone?.motion ?? 'unknown'
  const blocked = new Set((view?.data.blocklist.apps ?? []).map((a) => a.toLowerCase()))

  if (!android) {
    return (
      <Page title="Your phone" subtitle="On iPhone, Lumi hears motion and speaks. iOS hides other apps from it, so there is nothing to count here.">
        <Motion motion={motion} />
      </Page>
    )
  }
  if (!grants.usage) {
    return (
      <Page title="Your phone" subtitle="See how much of a session your phone takes.">
        <View style={{ backgroundColor: t.surface, borderRadius: radius.lg, padding: space[6], gap: space[4] }}>
          <Text variant="title3" style={{ fontWeight: '600' }}>
            Allow usage access
          </Text>
          <Text variant="body" tone="muted">
            Android shares app time and unlocks with apps you allow. Lumi reads counts and app names — never what is inside an app.
          </Text>
          <Button label="Open usage access" onPress={() => void openUsageSettings()} />
        </View>
      </Page>
    )
  }
  if (!session || !phone) {
    return (
      <Page title="Your phone" subtitle={session ? 'Counting starts with the first minute.' : 'Counts appear during a session.'}>
        <Motion motion={motion} />
      </Page>
    )
  }

  const apps = phone.apps
  const total = Math.max(1, phone.seconds)
  const sessionSeconds = Math.max(1, (Date.now() - Date.parse(session.startedAt)) / 1000)
  const share = Math.round((phone.seconds / sessionSeconds) * 100)
  const tones = [t.text, t.textMuted, t.textFaint, t.border]

  return (
    <Page title="Your phone" subtitle="This session">
      <View style={{ gap: space[2] }}>
        <Text variant="display1" style={{ fontWeight: '700', letterSpacing: -1.5, fontVariant: ['tabular-nums'] }}>
          {dur(phone.seconds)}
        </Text>
        <Text variant="body" tone="muted">
          {phone.seconds === 0
            ? 'Your phone has stayed out of it.'
            : `${share}% of the session so far · ${phone.unlocks} ${phone.unlocks === 1 ? 'unlock' : 'unlocks'}`}
        </Text>
      </View>

      {apps.length > 0 ? (
        <Section label="Where it went">
          <Svg height={14} width="100%">
            {apps.reduce<{ x: number; els: React.ReactElement[] }>(
              (acc, a, i) => {
                const w = (a.seconds / total) * 100
                acc.els.push(
                  <Rect
                    key={a.app}
                    x={`${acc.x}%`}
                    y={0}
                    width={`${Math.max(w - 0.6, 0.4)}%`}
                    height={14}
                    rx={4}
                    fill={blocked.has(a.app.toLowerCase()) ? t.warn : tones[Math.min(i, tones.length - 1)]}
                  />,
                )
                acc.x += w
                return acc
              },
              { x: 0, els: [] },
            ).els}
          </Svg>
          <View style={{ backgroundColor: t.surface, borderRadius: radius.lg, paddingVertical: space[2] }}>
            {apps.slice(0, 8).map((a) => {
              const off = blocked.has(a.app.toLowerCase())
              return (
                <View key={a.app} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[2] }}>
                  <Monogram name={a.app} tone={off ? 'warn' : 'plain'} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="body" style={{ fontWeight: '500' }} numberOfLines={1}>
                        {a.app}
                      </Text>
                      <Text variant="body" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
                        {dur(a.seconds)}
                      </Text>
                    </View>
                    <View style={{ height: 4, borderRadius: radius.pill, backgroundColor: t.border }}>
                      <View
                        style={{
                          width: `${(a.seconds / apps[0]!.seconds) * 100}%`,
                          height: 4,
                          borderRadius: radius.pill,
                          backgroundColor: off ? t.warn : t.textMuted,
                        }}
                      />
                    </View>
                  </View>
                </View>
              )
            })}
          </View>
        </Section>
      ) : null}

      <Section label="Unlocks">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {phone.unlocks === 0 ? (
            <Text variant="body" tone="muted">
              None this session.
            </Text>
          ) : (
            Array.from({ length: Math.min(phone.unlocks, 60) }, (_, i) => (
              <View key={i} style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: t.textMuted }} />
            ))
          )}
        </View>
      </Section>

      <Motion motion={motion} />

      <Text variant="caption" tone="faint">
        Counts and app names only. Never messages, never what is on the screen.
      </Text>
    </Page>
  )
}

function Motion({ motion }: { motion: string }) {
  const t = useTheme()
  return (
    <Section label="Right now">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: t.surface, borderRadius: radius.lg, padding: space[4] }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: motion === 'walking' || motion === 'running' ? t.warn : motion === 'unknown' ? t.textFaint : t.accent }} />
        <Text variant="body" style={{ fontWeight: '500', flex: 1 }}>
          {MOTION[motion] ?? motion}
        </Text>
        <Text variant="small" tone="faint">
          {motion === 'walking' || motion === 'running'
            ? 'Lumi speaks here while you are away'
            : motion === 'unknown'
              ? 'no motion reported yet'
              : 'at the desk'}
        </Text>
      </View>
    </Section>
  )
}
