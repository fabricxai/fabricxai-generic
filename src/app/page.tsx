import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { visibleNav, type FactoryType } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'

/**
 * The root has no screen of its own. A signed-in caller goes to their work,
 * everyone else to the door.
 *
 * Owner, admin and merchandiser land on `/home` ("Your work") — the composed
 * queue of what needs them. Other roles still take the first screen their own
 * nav offers, so a storekeeper is not greeted by an office feed.
 *
 * `visibleNav` is the same list the sidebar is built from, so a non-home
 * landing is by definition one they can open. A caller whose nav is empty goes
 * to `/settings`: every role can read it, and somebody with no modules at all
 * needs to see who to ask.
 */
export default async function Home() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const landsOnHome = ctx.roles.some((r) => r === 'owner' || r === 'admin' || r === 'merchandiser')
  if (landsOnHome) redirect('/home')

  const profile = await companyProfile(ctx)
  const factoryType: FactoryType = profile?.factoryType ?? 'woven'
  const [first] = visibleNav(ctx.roles, factoryType)

  redirect(first?.href ?? '/settings')
}
