import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'

import { theme, type ThemeName } from '@heli/tokens'

export type Theme = (typeof theme)[ThemeName]

const ThemeContext = createContext<Theme>(theme.light)

/**
 * The system colour scheme, resolved to the token roles. Both themes ship; dark
 * is not a fallback for a missing one.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme()
  const value = useMemo<Theme>(() => (scheme === 'dark' ? theme.dark : theme.light), [scheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = (): Theme => useContext(ThemeContext)
