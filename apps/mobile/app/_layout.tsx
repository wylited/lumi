import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { configureNotifications } from '@/lib/notify'
import { loadPairing } from '@/lib/store'
import { ThemeProvider } from '@/lib/theme'

/**
 * No bundled fonts: the system face is what a phone expects, and the font-loading
 * hook ran before anything else could render — one crash there is a dead app.
 */
function Root() {
  useEffect(() => {
    void loadPairing()
    void configureNotifications()
  }, [])

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
