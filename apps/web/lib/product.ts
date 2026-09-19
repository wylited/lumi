/** Every fact the site states about the product, in one place. */

export const PRICE = { unit: 79, currency: 'USD' } as const

export const DOWNLOAD = {
  appleSilicon: 'https://github.com/Mutesa-Cedric/helicopter/releases/latest',
  intel: 'https://github.com/Mutesa-Cedric/helicopter/releases/latest',
  requires: 'macOS 13 Ventura or later',
} as const

export function price(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: PRICE.currency, maximumFractionDigits: 0 }).format(n)
}
