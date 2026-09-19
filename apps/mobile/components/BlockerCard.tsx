import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

import type { MobileBlocklist } from '@heli/contracts'

import { Button, Card, Label, Row, Text } from '@/components/ui'
import { blockerAvailable, blockerEnabled, openBlockerSettings, syncBlocklist } from '@/lib/blocker'

const SYNC_MS = 20_000

/**
 * Blocking on this phone: whether the service is on, and what the open session blocks. The list
 * is kept current here while the app runs; the service keeps the last one when it does not.
 */
export function BlockerCard({ serverUrl, token }: { serverUrl: string; token: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [list, setList] = useState<MobileBlocklist | null>(null)

  useEffect(() => {
    if (!blockerAvailable) return
    const check = () => void blockerEnabled().then(setEnabled)
    const sync = () => void syncBlocklist(serverUrl, token).then((l) => l && setList(l))
    check()
    sync()
    const t = setInterval(sync, SYNC_MS)
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        check()
        sync()
      }
    })
    return () => {
      clearInterval(t)
      sub.remove()
    }
  }, [serverUrl, token])

  if (!blockerAvailable) return null

  const detail = !enabled
    ? 'Turn on “Lumi blocking” in Accessibility. Lumi then sends you home from apps your goal blocks, during a session, and tells you — with undo.'
    : list?.active
      ? `Blocking ${list.apps.join(', ')} for “${list.goal}”. Undo from the notification.`
      : 'On. Nothing is blocked right now: no session is open, or its goal blocks no apps.'

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Label>Blocking</Label>
        {enabled === null ? null : (
          <Text variant="caption" tone={enabled ? 'accent' : 'warn'}>
            {enabled ? (list?.active ? 'active' : 'on') : 'off'}
          </Text>
        )}
      </Row>
      <Text variant="small" tone="muted">
        {detail}
      </Text>
      {enabled === false ? (
        <Button label="Open Accessibility settings" tone="quiet" onPress={() => void openBlockerSettings()} />
      ) : null}
    </Card>
  )
}
