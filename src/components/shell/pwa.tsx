'use client'

import { useEffect } from 'react'

/**
 * Service-worker registration (mobile contract §2, plan 4.1).
 *
 * Mounted once in the root layout; renders nothing. The kill-switch is
 * `NEXT_PUBLIC_PWA=off`: with it set, this not only stops registering — it UNREGISTERS
 * whatever is already installed on the next visit, because a kill-switch that leaves the
 * old worker running has killed nothing. Statically inlined at build time, which is what
 * a client-side flag has to be.
 *
 * Registration failure is swallowed deliberately: an old browser without SW support gets
 * the app exactly as it was before this file existed, which is the contract's whole
 * non-regression promise.
 */
export function PwaRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    if (process.env.NEXT_PUBLIC_PWA === 'off') {
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) void reg.unregister()
      })
      return
    }

    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // No SW is the pre-PWA behaviour, which is a working app.
    })
  }, [])

  return null
}

/**
 * Subscribe THIS device to push, for the skins (4.2+) to call from a settings toggle.
 * Returns false when push is unconfigured, denied, or unsupported — the caller shows
 * "not available" and nothing breaks.
 */
export async function subscribeThisDevice(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false

  const { getPushConfig, savePushSubscription } = await import('@/modules/core/push-actions')
  const { publicKey } = await getPushConfig()
  if (!publicKey) return false

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false

  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return false

  const result = await savePushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent.slice(0, 200),
  })
  return !('error' in (result as object))
}
