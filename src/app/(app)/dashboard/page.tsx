import { redirect } from 'next/navigation'

/**
 * The owner had two mornings (role audit S2, plan 2.1).
 *
 * This route and `/home` both opened with the exceptions feed — two screens claiming to be
 * the start of the day, splitting the most important user's habit. Home won because its
 * queues are actionable and figures are context: an owner acts first and reads second. The
 * figures, buyer scorecards and reports this page rendered live on `/home` now
 * (`owner-figures.tsx`), below the queues, unchanged — denominators, as-of and all.
 *
 * The route stays as a redirect rather than being deleted: bookmarks, muscle memory and
 * every old link keep working, and the NAV entry stays (hidden from the sidebar) because
 * the shell refuses any path without one — a redirect nobody can reach redirects nobody.
 */
export default function DashboardPage() {
  redirect('/home')
}
