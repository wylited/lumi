import { View } from 'react-native'

import { radius, space } from '@heli/tokens'

import { IconHome, IconShield, IconUndo } from '@/components/icons'
import { Monogram, Page, Section } from '@/components/kit'
import { Button, Text } from '@/components/ui'
import { openBlockerSettings, useBlockLog } from '@/lib/blocker'
import { quoted, timeOfDay } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useTheme } from '@/lib/theme'

/** Blocking: whether it is on, what the goal blocks, and what happened. */
export default function Blocking() {
  const t = useTheme()
  const { view, grants, android } = useLive()
  const log = useBlockLog()
  const list = view?.data.blocklist
  const active = !!list?.active

  if (!android) {
    return (
      <Page title="Blocking" subtitle="iOS keeps other apps out of reach, so Lumi cannot block on iPhone. Your Mac still blocks what the goal lists." >
        <View />
      </Page>
    )
  }

  const status = !grants.blocking
    ? { title: 'Off', body: 'Turn on “Lumi blocking” in Accessibility. Lumi only ever sees which app opened.', tone: t.textFaint, wash: t.surface }
    : active
      ? { title: 'On', body: `Open a blocked app and Lumi sends you home, then tells you. Undo from the notification.`, tone: t.accent, wash: t.accentWash }
      : { title: 'Ready', body: 'Nothing to block right now: no session, or the goal lists no apps or does not allow changes.', tone: t.textMuted, wash: t.surface }

  return (
    <Page title="Blocking" subtitle={list?.goal ? `For ${quoted(list.goal)}` : 'Driven by the goal on your Mac'}>
      <View style={{ backgroundColor: status.wash, borderRadius: radius.lg, padding: space[6], gap: space[4] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <IconShield color={status.tone} size={32} />
          <Text variant="display2" style={{ fontWeight: '700', color: status.tone, letterSpacing: -0.6 }}>
            {status.title}
          </Text>
        </View>
        <Text variant="body" tone="muted">
          {status.body}
        </Text>
        {!grants.blocking ? <Button label="Open Accessibility" onPress={() => void openBlockerSettings()} /> : null}
      </View>

      <Section label="Blocked this session">
        {active && list ? (
          <View style={{ backgroundColor: t.surface, borderRadius: radius.lg, paddingVertical: space[2] }}>
            {list.apps.map((app) => (
              <View key={app} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[2] }}>
                <Monogram name={app} tone="warn" />
                <Text variant="body" style={{ fontWeight: '500', flex: 1 }}>
                  {app}
                </Text>
                <Text variant="small" tone="faint">
                  from your goal
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text variant="body" tone="muted">
            None. Blocked apps come from the goal on your Mac, with “Change my machine” on.
          </Text>
        )}
      </Section>

      <Section label="What happened">
        {log.length === 0 ? (
          <Text variant="body" tone="muted">
            Nothing blocked yet.
          </Text>
        ) : (
          <View style={{ gap: 0 }}>
            {log.slice(0, 12).map((e, i) => {
              const home = e.action === 'sent_home'
              return (
                <View key={`${e.ts}${i}`} style={{ flexDirection: 'row', gap: space[3] }}>
                  <View style={{ alignItems: 'center', width: 28 }}>
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: home ? t.warnWash : t.surfaceRaised,
                      }}
                    >
                      {home ? <IconHome color={t.warn} size={14} /> : <IconUndo color={t.textMuted} size={14} />}
                    </View>
                    {i < Math.min(log.length, 12) - 1 ? <View style={{ width: 1.5, flex: 1, backgroundColor: t.border }} /> : null}
                  </View>
                  <View style={{ flex: 1, paddingBottom: space[4], gap: 2 }}>
                    <Text variant="body" style={{ fontWeight: '500' }}>
                      {home ? `Sent home from ${e.app}` : `${e.app}, undone for 10 min`}
                    </Text>
                    <Text variant="small" tone="faint">
                      {timeOfDay(e.ts)}
                    </Text>
                  </View>
                </View>
              )
            })}
          </View>
        )}
      </Section>
    </Page>
  )
}
