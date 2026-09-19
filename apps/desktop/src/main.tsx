import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '@heli/ui'
import { App } from './app'
import { presenterOn } from './lib/presenter'

// The desktop app is light only: one palette to get right, and it reads well on a lit desk.
document.documentElement.dataset.theme = 'light'
if (presenterOn()) document.documentElement.setAttribute('data-presenter', '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
