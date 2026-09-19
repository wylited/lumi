import * as Notifications from 'expo-notifications'

/**
 * A nudge has to land when the phone is in a pocket, which is exactly when the
 * app is not on screen — so it is a notification first and an in-app card
 * second. The same message the desktop shows; the policy wrote it either way.
 */

let configured = false

export async function configureNotifications(): Promise<void> {
  if (configured) return
  configured = true

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  })

  await Notifications.requestPermissionsAsync()
}

export async function showNudge(message: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Lumi', body: message, sound: false },
      trigger: null,
    })
  } catch {
    // A notification that cannot be shown must not take the socket down with it;
    // the in-app card is already on screen when the app is foreground.
  }
}
