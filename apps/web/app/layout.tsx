import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: { default: 'Helicopter — set a goal, it makes sure it happens', template: '%s · Helicopter' },
  description:
    'A desk unit and a desktop app that notice when you drift from what you sat down to do, and step in — a nudge, a spoken line, a change — only when it matters.',
}

export const viewport: Viewport = { colorScheme: 'light' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body className="min-h-dvh bg-bg text-text antialiased">{children}</body>
    </html>
  )
}
