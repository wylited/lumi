import { useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { Redirect, router } from 'expo-router'
import * as Device from 'expo-device'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { layout, radius, space, type } from '@heli/tokens'

import { Ring } from '@/components/ring'
import { Button, Text } from '@/components/ui'
import { APP_VERSION, normalizeBase, pairPhone } from '@/lib/api'
import { savePairing, usePairing } from '@/lib/store'
import { useTheme } from '@/lib/theme'

/**
 * Pairing, the desktop's trust the other way round: the Mac shows a six-digit code, this screen
 * redeems it for a token that lives in the phone's keychain. No account, no password, and the code
 * dies the moment it is used.
 */
export default function PairScreen() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { ready, pairing } = usePairing()

  const [serverUrl, setServerUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001')
  const [code, setCode] = useState('')
  const [name, setName] = useState(Device.deviceName ?? Device.modelName ?? 'My phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const codeInput = useRef<TextInput>(null)

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

  const row = {
    flex: 1,
    color: t.text,
    fontFamily: type.family.ui,
    fontSize: 15,
    textAlign: 'right' as const,
    paddingVertical: 0,
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + space[8],
          paddingBottom: insets.bottom + space[8],
          paddingHorizontal: layout.gutter,
          gap: space[8],
        }}
      >
        <View style={{ alignItems: 'center', gap: space[6] }}>
          <Ring size={148} session={null} speaking={false}>
            <Text variant="title3" style={{ fontWeight: '700', letterSpacing: -0.4 }}>
              lumi
            </Text>
          </Ring>
          <View style={{ alignItems: 'center', gap: space[2] }}>
            <Text variant="display2" style={{ fontWeight: '700', letterSpacing: -0.8, textAlign: 'center' }}>
              Pair with your Mac
            </Text>
            <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
              In Lumi on your Mac, open Settings and get a pairing code. It works once, for five minutes.
            </Text>
          </View>
        </View>

        <Pressable onPress={() => codeInput.current?.focus()} accessibilityLabel="Pairing code">
          <View style={{ flexDirection: 'row', gap: space[2], justifyContent: 'center' }}>
            {Array.from({ length: 6 }, (_, i) => {
              const digit = code[i]
              const active = focused && i === Math.min(code.length, 5)
              return (
                <View
                  key={i}
                  style={{
                    width: 48,
                    height: 60,
                    borderRadius: radius.md,
                    backgroundColor: t.surface,
                    borderWidth: active ? 2 : StyleSheet.hairlineWidth,
                    borderColor: active ? t.accent : t.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text variant="title1" style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>
                    {digit ?? ''}
                  </Text>
                </View>
              )
            })}
          </View>
          <TextInput
            ref={codeInput}
            value={code}
            onChangeText={(value) => setCode(value.replace(/[^0-9]/g, '').slice(0, 6))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={6}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (code.length === 6 && !busy) void submit()
            }}
            autoFocus
            style={{ ...StyleSheet.absoluteFillObject, opacity: 0.01 }}
          />
        </Pressable>

        <View style={{ backgroundColor: t.surface, borderRadius: radius.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], minHeight: 52 }}>
            <Text variant="body" style={{ fontWeight: '500' }}>
              This phone
            </Text>
            <TextInput value={name} onChangeText={setName} style={row} placeholderTextColor={t.textFaint} />
          </View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: space[4] }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], minHeight: 52 }}>
            <Text variant="body" style={{ fontWeight: '500' }}>
              Your Mac
            </Text>
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="http://192.168.1.24:3001"
              placeholderTextColor={t.textFaint}
              style={row}
            />
          </View>
        </View>

        <View style={{ gap: space[3] }}>
          {error !== null ? (
            <Text variant="small" tone="danger" style={{ textAlign: 'center' }}>
              {error}
            </Text>
          ) : null}
          <Button label={busy ? 'Pairing…' : 'Pair'} onPress={() => void submit()} disabled={busy || code.length !== 6} />
          <Text variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            {Platform.OS === 'android'
              ? 'Use the Mac’s Wi-Fi address — on this phone, localhost is the phone.'
              : 'On iPhone, Lumi hears motion and speaks; iOS keeps other apps’ time to itself.'}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
