import { useState } from 'react'
import { Platform, ScrollView, TextInput } from 'react-native'
import { Redirect, router } from 'expo-router'
import * as Device from 'expo-device'

import { space, type } from '@heli/tokens'

import { Button, Card, Label, Row, Screen, Text } from '@/components/ui'
import { APP_VERSION, normalizeBase, pairPhone } from '@/lib/api'
import { savePairing, usePairing } from '@/lib/store'
import { useTheme } from '@/lib/theme'

/**
 * Pairing, the desktop's trust the other way round: the Mac shows a six-digit
 * code in its setup screen, this screen redeems it for a token that lives in the
 * phone's keychain. No account, no password, and the code dies the moment it is
 * used.
 */
export default function PairScreen() {
  const t = useTheme()
  const { ready, pairing } = usePairing()

  const [serverUrl, setServerUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001')
  const [code, setCode] = useState('')
  const [name, setName] = useState(Device.deviceName ?? Device.modelName ?? 'My phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (ready && pairing !== null) return <Redirect href="/" />

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const base = normalizeBase(serverUrl)
      const response = await pairPhone(base, {
        code: code.trim(),
        name: name.trim().length > 0 ? name.trim() : 'My phone',
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVersion: APP_VERSION,
      })
      await savePairing({
        serverUrl: base,
        token: response.token,
        phoneId: response.phoneId,
        phoneName: name.trim(),
      })
      router.replace('/')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pairing failed.')
    } finally {
      setBusy(false)
    }
  }

  const field = {
    backgroundColor: t.surfaceRaised,
    borderColor: t.border,
    borderRadius: 10,
    borderWidth: 1,
    color: t.text,
    fontFamily: type.family.ui,
    fontSize: 15,
    paddingHorizontal: space[3],
    minHeight: 44,
  } as const

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space[4], paddingVertical: space[6] }}>
        <Text variant="title1">Pair this phone</Text>
        <Text variant="small" tone="muted">
          On the Mac, open the setup screen and ask for a pairing code. It is six digits and it works
          once.
        </Text>

        <Card>
          <Label>Server</Label>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.24:3001"
            placeholderTextColor={t.textFaint}
            style={field}
          />
          <Text variant="caption" tone="faint">
            The Mac's LAN address, not localhost — on this phone, localhost is this phone.
          </Text>
        </Card>

        <Card>
          <Label>Code from the Mac</Label>
          <TextInput
            value={code}
            onChangeText={(value) => setCode(value.replace(/[^0-9]/g, '').slice(0, 6))}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={6}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (code.length === 6 && !busy) void submit()
            }}
            placeholder="000000"
            placeholderTextColor={t.textFaint}
            style={[field, { fontFamily: type.family.mono, fontSize: 24, letterSpacing: 6 }]}
          />

          <Label>This phone's name</Label>
          <TextInput value={name} onChangeText={setName} style={field} />
        </Card>

        {error !== null ? (
          <Text variant="small" tone="danger">
            {error}
          </Text>
        ) : null}

        <Button label={busy ? 'Pairing…' : 'Pair'} onPress={() => void submit()} disabled={busy || code.length !== 6} />
        <Row style={{ justifyContent: 'center' }}>
          <Text variant="caption" tone="faint">
            {Platform.OS === 'android'
              ? 'Android will then ask for usage access, which is how it sees app time.'
              : 'On iOS this phone reports motion and is spoken to; app usage is not readable without Apple’s Screen Time entitlement.'}
          </Text>
        </Row>
      </ScrollView>
    </Screen>
  )
}
