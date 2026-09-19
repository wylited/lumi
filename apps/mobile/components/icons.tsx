import Svg, { Circle, Path, Rect } from 'react-native-svg'

/** A small line-icon set, drawn here so the app ships no icon font. 24-unit grid, 1.8 stroke. */

interface IconProps {
  color: string
  size?: number
}

function Frame({ size = 24, children }: { size?: number; children: React.ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {children}
    </Svg>
  )
}

/** Now: the ring, with the one lit dot. */
export function IconNow({ color, size }: IconProps) {
  return (
    <Frame size={size}>
      <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={1.8} strokeDasharray="1.6 2.6" strokeLinecap="round" />
      <Circle cx={12} cy={3.5} r={2} fill={color} />
    </Frame>
  )
}

export function IconPhone({ color, size }: IconProps) {
  return (
    <Frame size={size}>
      <Rect x={6.5} y={2.75} width={11} height={18.5} rx={2.6} stroke={color} strokeWidth={1.8} />
      <Path d="M10.5 18h3" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Frame>
  )
}

export function IconShield({ color, size }: IconProps) {
  return (
    <Frame size={size}>
      <Path
        d="M12 3 5 5.8v5.4c0 4.3 2.9 8 7 9.8 4.1-1.8 7-5.5 7-9.8V5.8L12 3Z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Path d="m9.2 12.1 2 2 3.8-4" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Frame>
  )
}

export function IconYou({ color, size }: IconProps) {
  return (
    <Frame size={size}>
      <Circle cx={12} cy={8.5} r={3.8} stroke={color} strokeWidth={1.8} />
      <Path d="M4.8 20c1-3.6 3.8-5.6 7.2-5.6s6.2 2 7.2 5.6" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Frame>
  )
}

export function IconChevron({ color, size = 18 }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="m9.5 6 6 6-6 6" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Frame>
  )
}

export function IconHome({ color, size = 16 }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1v-7.5Z" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
    </Frame>
  )
}

export function IconUndo({ color, size = 16 }: IconProps) {
  return (
    <Frame size={size}>
      <Path d="M9 7 4.5 11.5 9 16" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5 11.5h9.5a5 5 0 0 1 0 10H12" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Frame>
  )
}
