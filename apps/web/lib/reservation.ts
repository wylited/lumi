import { z } from 'zod'

/** What the order form sends. Shared by the form and the route, so they cannot drift. */
export const Reservation = z.object({
  name: z.string().trim().min(1, 'Your name').max(80),
  email: z.string().trim().email('A real email, so we can reach you'),
  country: z.string().trim().min(2).max(56),
  quantity: z.number().int().min(1).max(3),
})
export type Reservation = z.infer<typeof Reservation>
