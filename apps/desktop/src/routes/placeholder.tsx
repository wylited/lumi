import { EmptyState } from '@heli/ui'

/** Holds a route's place in the shell until its own commit lands. */
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-8">
      <EmptyState title={`${title} arrives with its own commit.`} />
    </div>
  )
}
