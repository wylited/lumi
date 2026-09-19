import { View } from 'react-native'
import { Redirect, Tabs } from 'expo-router'

import { IconNow, IconPhone, IconShield, IconYou } from '@/components/icons'
import { NudgeSheet, TabBar } from '@/components/kit'
import { LiveProvider, useLive } from '@/lib/live'
import { usePairing } from '@/lib/store'

function Shell() {
  const { nudge, answer, grants, android } = useLive()
  const needsYou = !grants.notifications || (android && (!grants.usage || !grants.blocking))
  return (
    <View style={{ flex: 1 }}>
      <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
        <Tabs.Screen name="index" options={{ title: 'Now', tabBarIcon: ({ color }) => <IconNow color={color} /> }} />
        <Tabs.Screen name="phone" options={{ title: 'Phone', tabBarIcon: ({ color }) => <IconPhone color={color} /> }} />
        <Tabs.Screen name="blocking" options={{ title: 'Blocking', tabBarIcon: ({ color }) => <IconShield color={color} /> }} />
        <Tabs.Screen
          name="you"
          options={{ title: 'You', tabBarBadge: needsYou ? '' : undefined, tabBarIcon: ({ color }) => <IconYou color={color} /> }}
        />
      </Tabs>
      <NudgeSheet nudge={nudge} onAnswer={answer} />
    </View>
  )
}

/** Four tabs over one live connection. An unpaired phone goes to pairing first. */
export default function TabsLayout() {
  const { ready, pairing } = usePairing()
  if (!ready) return null
  if (pairing === null) return <Redirect href="/pair" />
  return (
    <LiveProvider pairing={pairing}>
      <Shell />
    </LiveProvider>
  )
}
