import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: { default: 'Helicopter', template: '%s · Helicopter' },
  description:
    'An observer that watches the desk and the machine, and acts — a nudge, a spoken line, a change — so the goal you set actually happens.',
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-text antialiased">{children}</body>
    </html>
  )
}
