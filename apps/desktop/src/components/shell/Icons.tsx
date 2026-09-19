import type { SVGProps } from 'react'

/** Four glyphs, one stroke weight. Drawn here so the app ships no icon library. */
function Glyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[18px] shrink-0"
      {...props}
    />
  )
}

export const GoalIcon = () => (
  <Glyph>
    <circle cx="10" cy="10" r="7" />
    <circle cx="10" cy="10" r="3.5" />
    <circle cx="10" cy="10" r="0.6" fill="currentColor" />
  </Glyph>
)

export const LiveIcon = () => (
  <Glyph>
    <path d="M2.5 10h3l2-5 3.5 10 2-5h4.5" />
  </Glyph>
)

export const HistoryIcon = () => (
  <Glyph>
    <path d="M3 16.5V9M7.5 16.5V4M12 16.5v-6M16.5 16.5V7" />
  </Glyph>
)

export const SettingsIcon = () => (
  <Glyph>
    <path d="M3.5 6h8M15.5 6h1M3.5 14h1M8.5 14h8" />
    <circle cx="13.5" cy="6" r="2" />
    <circle cx="6.5" cy="14" r="2" />
  </Glyph>
)
