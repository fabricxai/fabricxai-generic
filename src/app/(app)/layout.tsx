import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { AlertsPopover } from '@/components/shell/alerts-popover'
import { MarbimButton } from '@/components/shell/marbim-button'
import { marbimEntryFor } from '@/components/shell/marbim-context'
import { MarbimPanel } from '@/components/shell/marbim-panel'
import { OutcomeToasts } from '@/components/shell/outcome-toasts'
import { PendingReadings } from '@/components/shell/pending-readings'
import { PageBody, TopBar } from '@/components/shell/page-shell'
import { Sidebar } from '@/components/shell/sidebar'
import { AccountMenu } from '@/components/shell/account-menu'
import {
  describeRoles,
  navLabelKey,
  resolveAccess,
  visibleNav,
  type FactoryType,
} from '@/components/shell/nav'
import { LockedState, ReadOnlyNote } from '@/components/fx/feedback'
import { LocaleProvider } from '@/components/fx/locale'
import { t } from '@/lib/i18n'
import { tui } from '@/lib/i18n-ui'
import { env } from '@/lib/env'
import { requestLocale } from '@/lib/ui-locale'
import { marbimTrust, routedPendingCount } from '@/modules/approvals/queries'
import type { ApprovalsPolicy } from '@/modules/approvals/service'
import { activeModuleIds } from '@/modules/core/activation'
import { listUnread } from '@/modules/core/notifications'
import { getCtx, signedInUser } from '@/modules/core/session'
import { providerSurfaceLabel } from '@/modules/marbim/provider'
import { companyDisplayName, companyProfile, getPolicy } from '@/modules/settings/service'

/**
 * The authenticated shell.
 *
 * Nav is computed on the SERVER from the caller's roles and the unit's factory
 * type, so a module a role cannot open is never sent to the browser at all.
 * That is the "hidden" access pattern from the screens brief; "redacted" (masked
 * fields) stays inside each screen, because only the screen knows which fields
 * are sensitive.
 *
 * **"Locked" is enforced HERE, once, rather than per screen.** Hiding a link is not access
 * control: eighteen of the twenty-three destinations rendered in full for any signed-in
 * role that typed the address, so a storekeeper could read the LC register — every credit,
 * its value and the factory's open exposure — by knowing the word "lcs". Five pages called
 * `canSee` themselves and the rest never had it added, which is what happens to a check
 * that must be remembered twenty-three times.
 *
 * Doing it in the shell also covers nested routes: `navItemFor` longest-matches, so
 * `/lcs/{id}` and `/orders/{po}` are governed by their module's entry without each dynamic
 * route repeating anything. The pathname arrives from `src/proxy.ts`, since a layout is
 * never handed one.
 *
 * This is the LAST wall, not the only one. Every service still checks tenancy, every gate
 * still fails closed, and payroll still refuses at its own service boundary.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers()
  const ctx = await getCtx(requestHeaders)
  if (!ctx) redirect('/login')

  const [me, profile, displayName, trust, approvalsPolicy, unread, activeModules] =
    await Promise.all([
      signedInUser(requestHeaders),
      companyProfile(ctx),
      companyDisplayName(ctx),
      marbimTrust(ctx),
      getPolicy<ApprovalsPolicy>(ctx, 'approvals'),
      listUnread(ctx, 20),
      // Which modules THIS factory runs (spec §1) — the sidebar and the route wall
      // below both read the one set, so they cannot disagree.
      activeModuleIds(ctx),
    ])

  // Approve badge counts what is routed to THIS reviewer, not every draft in the company.
  // A storekeeper whose inbox reads "Nothing routed to you" must not carry a "4" on every
  // screen — a badge that cannot be cleared is one people stop reading.
  const routed = await routedPendingCount(ctx, approvalsPolicy)
  // The factory's configured language is the default for a device that has not chosen
  // one. Every client component reads this through `LocaleProvider` below.
  const locale = await requestLocale(profile?.locale)
  const factoryType: FactoryType = profile?.factoryType ?? 'woven'
  const alertItems = unread.map((n) => ({
    id: n.id,
    title: t(locale, n.titleKey, (n.params ?? {}) as Record<string, unknown>),
    body: n.bodyKey
      ? t(locale, n.bodyKey, (n.params ?? {}) as Record<string, unknown>)
      : undefined,
    href: n.href,
    severity: n.severity as 'info' | 'warning' | 'critical',
    age: alertAge(n.createdAt),
  }))
  /*
   * Whether the copilot is offered at all (plan 6.1, audit AI-B1).
   *
   * `MARBIM_ENABLED` was declared, validated at boot and read by NOTHING — so with it off
   * the button, the panel and the nav entry all still mounted, `/marbim` still opened, and
   * chat hard-failed once per turn against a provider that was never registered. "Pilot
   * with MARBIM off" was not a configuration this product supported.
   */
  const marbimEnabled = env.MARBIM_ENABLED
  const nav = visibleNav(ctx.roles, factoryType, marbimEnabled, activeModules)

  /*
   * Which screen is being rendered, and whether this role may. The decision itself lives in
   * `resolveAccess` so it can be tested as a function rather than as this file's source; a
   * path with no registry entry is refused there, not waved through.
   */
  const pathname = requestHeaders.get('x-pathname') ?? ''
  const { item, allowed, readOnly, subject, inactive } = resolveAccess(
    pathname,
    ctx.roles,
    factoryType,
    (key, params) => tui(locale, key, params),
    activeModules,
  )

  return (
    <LocaleProvider locale={locale}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
        <TopBar
          companyName={displayName ?? 'FabricXAI'}
          account={
            <AccountMenu
              name={me?.name ?? null}
              email={me?.email ?? ''}
              roleLabel={describeRoles(ctx.roles, (key, params) => tui(locale, key, params))}
              companyName={displayName ?? 'FabricXAI'}
            />
          }
          actions={
            <>
              <AlertsPopover alerts={alertItems} />
              {marbimEnabled ? <MarbimButton /> : null}
            </>
          }
        />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <Sidebar items={nav} badges={routed > 0 ? { approve: routed } : {}} />
          <PageBody>
            {allowed ? (
              <>
                {/* Said before anything is typed, not after a button is pressed. The write
                    itself is still refused by the action — this is the label, not the lock. */}
                {readOnly && item ? <ReadOnlyNote what={tui(locale, navLabelKey(item.id))} /> : null}
                {/*
                  A reading nobody has checked follows the PERSON, not the screen.
                  
                  It used to be mounted on four pages — home, store, cutting, maintenance —
                  and a quality inspector signing in lands on `/quality/inline`, so the one
                  item the product itself calls "blocking itself" was not on the screen they
                  arrived at. A merchandiser's measurement chart sat unconfirmed for three
                  days that way (Nordkap §7, F34). Mounted once here, it is wherever they are.
                  
                  It renders nothing when there are none, so somebody who never files a
                  document never sees it.
                */}
                <PendingReadings />
                {children}
              </>
            ) : (
              // `off` changes the sentence, not the wall: "switched off for this
              // factory" instead of "you don't have access", because sending an owner
              // to ask themselves for permission would be nonsense.
              <LockedState what={subject} off={inactive} />
            )}
          </PageBody>
        </div>
        {/* X.2: MARBIM is a surface over whatever screen you are on, not a place you go. The
            FAB sits bottom-right of every screen and the panel opens over it; mounted here in
            the shell so the thread survives navigation. */}
        {marbimEnabled ? (
          <MarbimPanel
            entry={{
              // The screen's own chips win over the role's: the question a person on the
              // receiving bay has is about the shelf in front of them, not their job title.
              ...marbimEntryFor(ctx.roles, {
                pathname,
                words: (key, params) => tui(locale, key, params),
              }),
              model: providerSurfaceLabel(),
            }}
            trust={{ ...trust, pending: routed }}
          />
        ) : null}
        {/* The shared outcome stack: every action's done/refused/failed lands here as a
            small edge toast, fed by the two chokepoints every screen already uses
            (live-test feedback, Phase 9). */}
        <OutcomeToasts />
      </div>
    </LocaleProvider>
  )
}

/**
 * How long ago, in words. Reads the clock itself so the layout's own body stays pure —
 * a render that calls `Date.now()` is a render React is entitled to treat as repeatable
 * and is not, which the hooks lint says out loud.
 */
function alertAge(createdAt: Date): string {
  const hours = Math.floor(Math.max(0, Date.now() - createdAt.getTime()) / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day' : `${days} days`
}

