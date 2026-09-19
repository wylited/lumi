import type { ReactNode } from 'react'
import { Header } from '@/components/shell/Header'
import { dataSource } from '@/lib/api'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const source = await dataSource()
  return (
    <div className="flex min-h-dvh flex-col">
      <Header source={source} />
      {children}
    </div>
  )
}
