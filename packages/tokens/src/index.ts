/**
 * @heli/tokens — the single source for colour, type, space, radius and motion.
 *
 * Web reads the CSS custom properties in tokens.css.
 * React Native / Expo reads these objects (no CSS vars there), via nativewind's preset.
 *
 * Both are generated from the same literals below. If you change a value, change it HERE
 * and run `pnpm --filter @heli/tokens build` — never edit tokens.css by hand.
 */

export const palette = {
  jade: {
    50: '#E9F8F1', 100: '#CBEEDE', 200: '#9BDEC3', 300: '#62C9A2', 400: '#2FB283',
    500: '#0FA36B', 600: '#0B8557', 700: '#0A6845', 800: '#084F35', 900: '#063723',
  },
  ink: {
    50: '#F3F7F5', 100: '#E3EBE7', 200: '#C2CFC9', 300: '#94A59E', 400: '#6B7D76',
    500: '#4A5C55', 600: '#2E403A', 700: '#1E2D28', 800: '#14201C', 900: '#0B1512',
  },
  amber: { 500: '#D9920B', soft: '#FBF1DA' },
  red: { 500: '#D24B3E', soft: '#FBE7E4' },
  white: '#FFFFFF',
} as const;

const { jade, ink, amber, red, white } = palette;

export const theme = {
  light: {
    bg: white,
    surface: ink[50],
    surfaceRaised: white,
    border: ink[100],
    borderStrong: ink[200],
    text: ink[900],
    textMuted: ink[600],
    textFaint: ink[500],
    accent: jade[500],
    accentHover: jade[600],
    accentStrong: jade[600],
    accentStrongHover: jade[700],
    accentContrast: white,
    accentWash: jade[50],
    accentLink: jade[700],
    warn: amber[500],
    warnWash: amber.soft,
    danger: red[500],
    dangerWash: red.soft,
  },
  dark: {
    bg: ink[900],
    surface: ink[800],
    surfaceRaised: ink[700],
    border: ink[700],
    borderStrong: ink[600],
    text: ink[50],
    textMuted: ink[200],
    textFaint: ink[300],
    accent: jade[300],
    accentHover: jade[200],
    accentStrong: jade[200],
    accentStrongHover: jade[100],
    accentContrast: ink[900],
    accentWash: '#0C2A1F',
    accentLink: jade[300],
    warn: amber[500],
    warnWash: '#2E2513',
    danger: red[500],
    dangerWash: '#331D1A',
  },
} as const;

export const type = {
  family: {
    ui: 'Plus Jakarta Sans',
    mono: 'JetBrains Mono',
  },
  /** size / lineHeight / letterSpacing / weight */
  scale: {
    display0: { size: 62, leading: 1.0, tracking: -0.035, weight: '700' },
    display1: { size: 48, leading: 1.04, tracking: -0.03, weight: '700' },
    display2: { size: 34, leading: 1.10, tracking: -0.025, weight: '700' },
    title1: { size: 26, leading: 1.20, tracking: -0.02, weight: '600' },
    title2: { size: 20, leading: 1.28, tracking: -0.015, weight: '600' },
    title3: { size: 17, leading: 1.38, tracking: -0.01, weight: '600' },
    body: { size: 15, leading: 1.55, tracking: 0, weight: '400' },
    bodyStrong: { size: 15, leading: 1.55, tracking: 0, weight: '500' },
    small: { size: 13.5, leading: 1.5, tracking: 0, weight: '400' },
    caption: { size: 12, leading: 1.4, tracking: 0.01, weight: '500' },
    label: { size: 11, leading: 1.3, tracking: 0.13, weight: '600' },
    mono: { size: 13, leading: 1.55, tracking: 0, weight: '400' },
  },
} as const;

export const space = {
  1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 14: 56, 18: 72,
} as const;

export const radius = {
  xs: 6, sm: 10, md: 14, lg: 20, pill: 999,
} as const;

export const motion = {
  fast: 120, base: 180, slow: 280,
  ease: 'cubic-bezier(.2,.7,.3,1)',
  /** RN equivalent — Easing.bezier(.2,.7,.3,1) */
  bezier: [0.2, 0.7, 0.3, 1] as const,
} as const;

export const layout = {
  measure: '68ch',
  gutter: 20,
  maxContent: 1180,
  /** minimum tap target on mobile, points */
  tapTarget: 44,
} as const;

/** The physical device, so the renders and the fallback illustrations agree. */
export const device = {
  body: '#EEF3F0',
  bodyDim: '#D9E4DF',
  joint: ink[800],
  glass: '#0A1210',
  led: jade[400],
} as const;

export type ThemeName = keyof typeof theme;
export type ThemeTokens = (typeof theme)['light'];
