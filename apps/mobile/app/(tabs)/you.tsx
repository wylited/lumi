import { View } from 'react-native'
import { router } from 'expo-router'
import * as Notifications from 'expo-notifications'

import { space } from '@heli/tokens'

import { Group, Item, Monogram, Page, Section } from '@/components/kit'
import { Text } from '@/components/ui'
import { APP_VERSION } from '@/lib/api'
import { openBlockerSettings } from '@/lib/blocker'
import { useLive } from '@/lib/live'
import { clearPairing } from '@/lib/store'
import { openUsageSettings } from '@/lib/usage'

/** You: this phone, what it is allowed to do, and how to leave. */
export default function You() {
  const { pairing, connection, grants, android, checkGrants, notice } = useLive()
  const host = pairing.serverUrl.replace(/^https?:\/\//, '')
  const allowed = (ok: boolean) => (ok ? 'Allowed' : 'Needs you')

  return (
    <Page title="You">
      <Group>
        <Item
          leading={<Monogram name={pairing.phoneName} tone="accent" size={44} />}
          title={pairing.phoneName}
          detail={`Paired with your Mac · ${host}`}
          value={connection === 'open' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'}
          valueTone={connection === 'open' ? 'accent' : 'warn'}
        />
      </Group>

      <Section label="Permissions">
        <Group>
          <Item
            title="Notifications"
            detail="Nudges and blocks reach you with the app closed"
            value={allowed(grants.notifications)}
            valueTone={grants.notifications ? 'accent' : 'warn'}
            onPress={() => void Notifications.requestPermissionsAsync().then(checkGrants)}
          />
          {android ? (
            <Item
              title="Usage access"
              detail="App time and unlocks, never what is inside"
              value={allowed(grants.usage)}
              valueTone={grants.usage ? 'accent' : 'warn'}
              onPress={() => void openUsageSettings()}
            />
          ) : null}
          {android ? (
            <Item
              title="Lumi blocking"
              detail="Sends you home from apps the goal blocks"
              value={allowed(grants.blocking)}
              valueTone={grants.blocking ? 'accent' : 'warn'}
              onPress={() => void openBlockerSettings()}
            />
          ) : null}
        </Group>
      </Section>

      <Section label="Privacy">
        <Text variant="body" tone="muted">
          This phone sends counts, app names and whether you are moving. Never messages, never what is on the screen, never a picture.
        </Text>
      </Section>

      <Group>
        <Item title="Unpair this phone" danger onPress={() => void clearPairing().then(() => router.replace('/pair'))} />
      </Group>

      <View style={{ alignItems: 'center', gap: 4, paddingTop: space[2] }}>
        {notice ? (
          <Text variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            {notice}
          </Text>
        ) : null}
        <Text variant="caption" tone="faint">
          Lumi {APP_VERSION}
        </Text>
      </View>
    </Page>
  )
}
