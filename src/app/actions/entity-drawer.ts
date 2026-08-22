'use server'

/**
 * The peek door (specs/order-centric-core.md §3).
 *
 * One action for every kind — the walls live in `core/drawer.ts` (`peekEntity`): the
 * kind must be registered, its module active for this tenant, the caller's roles on the
 * kind's list, and the reference resolvable. This file is only the boundary: session,
 * zod, and refusals as values so "that module is switched off" reaches the reader as a
 * sentence rather than production's masked React #441.
 *
 * `requireCtx` rather than `requireRole`, deliberately: a peek is a read whose audience
 * differs per kind, and the kind's own `roles` list (checked in `peekEntity`) is the
 * wall. A single role list here would either exclude a role some kind welcomes or
 * welcome a role some kind excludes.
 */
import { headers } from 'next/headers'
import { z } from 'zod'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { peekEntity, type DrawerPeek } from '@/modules/core/drawer'
import { ENTITY_REF_MAX } from '@/modules/core/refs'
import { requireCtx } from '@/modules/core/session'
// Registration is what makes a kind peekable, so the registry must be loaded before the
// first peek asks who owns what — the same reason every other surface imports it.
import '@/modules/registry'

const peekInput = z.object({
  // The vocabulary a module registers under — `order`, `document`. Same shape the
  // pending-target names hold to.
  kind: z.string().regex(/^[a-z_][a-z0-9_]*$/).max(40),
  reference: z.string().min(1).max(ENTITY_REF_MAX),
})

export async function openEntityPeek(
  input: z.input<typeof peekInput>,
): Promise<DrawerPeek | ActionFailure> {
  const ctx = await requireCtx(await headers())

  return surfaced(async () => {
    const { kind, reference } = peekInput.parse(input)
    return peekEntity(ctx, kind, reference)
  })
}
