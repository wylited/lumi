import { useEffect } from 'react'
import { View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono'

import { Text } from '@/components/ui'
import { configureNotifications } from '@/lib/notify'
import { loadPairing } from '@/lib/store'
import { ThemeProvider, useTheme } from '@/lib/theme'

function Boot() {
  const t = useTheme()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
      <Text variant="title1">Lumi</Text>
      <Text variant="small" tone="faint" style={{ marginTop: 8 }}>
        the phone that goes with you
      </Text>
    </View>
  )
}

function Root() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    JetBrainsMono_400Regular,
  })

  useEffect(() => {
    void loadPairing()
    void configureNotifications()
  }, [])

  if (!fontsLoaded) return <Boot />

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="pair" />
    </Stack>
  )
}

export default function Layout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="auto" />
        <Root />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
