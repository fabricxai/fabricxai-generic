/**
 * FabricXAI service worker (mobile contract §1/§2, plan 4.1).
 *
 * The contract's forbidden list is this file's whole design:
 *
 *  - CACHE-FIRST FOR SHELL ASSETS ONLY. `/_next/static/*` is content-hashed, so serving it
 *    from cache is always correct; icons and brand marks change never. Everything else —
 *    every route, every RSC payload, every API call — goes to the network untouched, because
 *    a floor tablet showing yesterday's UD balance is the exact failure this product exists
 *    to prevent.
 *  - NEVER TOUCH A WRITE. Non-GET requests are not intercepted at all: the offline queue
 *    already owns retry semantics with offline_key idempotency, and a second retry layer
 *    here would double-fire writes.
 *  - NO NAVIGATION FALLBACK. An offline navigation fails the way the browser fails, and the
 *    floor screens' own queue UI is the offline story — a cached shell pretending the app
 *    works offline would lie about everything inside it.
 *
 * Versioned by the cache name: bump SW_VERSION on any change to this file, and activation
 * deletes every cache that is not the current one.
 */
const SW_VERSION = 'fx-shell-v1'
const SHELL = /^\/(?:_next\/static\/|icon-\d+\.png$|brand\/)/

self.addEventListener('install', () => {
  // No precache list: the shell fills lazily as assets are fetched. skipWaiting so a new
  // version takes over on next load rather than waiting for every tab to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== SW_VERSION).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !SHELL.test(url.pathname)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(SW_VERSION)
      const hit = await cache.match(request)
      if (hit) return hit
      const response = await fetch(request)
      if (response.ok) cache.put(request, response.clone())
      return response
    })(),
  )
})

/**
 * Push: show the notification the server sent. The payload is built server-side from the
 * same rows the in-app bell reads — this handler renders, it never decides.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload
  try {
    payload = event.data.json()
  } catch {
    return
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'FabricXAI', {
      body: payload.body ?? '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag,
      data: { href: payload.href ?? '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const href = event.notification.data?.href ?? '/'
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = all.find((c) => 'focus' in c)
      if (open) {
        await open.focus()
        if ('navigate' in open) await open.navigate(href)
      } else {
        await self.clients.openWindow(href)
      }
    })(),
  )
})
