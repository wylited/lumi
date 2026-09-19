/** Presenter mode: a per-machine display preference, applied to the root element. */
const KEY = 'lumi.presenter'

export function presenterOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setPresenter(on: boolean) {
  document.documentElement.toggleAttribute('data-presenter', on)
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // applied for this run only
  }
  window.dispatchEvent(new Event('lumi:presenter'))
}
