import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { landingFor, type FactoryType } from '@/components/shell/nav'
import { env } from '@/lib/env'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'

/**
 * The root has no screen of its own. A signed-in caller goes to their work,
 * everyone else to the door.
 *
 * WHERE their work is lives in `landingFor` beside the nav registry, as a
 * function — because "which screen does a storekeeper see first every morning"
 * is a decision worth testing, and the previous answer here was "whatever the
 * sidebar ordered first", which greeted the floor with an empty approve inbox
 * (adoption plan 1.1).
 */
export default async function Home() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const profile = await companyProfile(ctx)
  const factoryType: FactoryType = profile?.factoryType ?? 'woven'

  redirect(landingFor(ctx.roles, factoryType, env.MARBIM_ENABLED))
}
