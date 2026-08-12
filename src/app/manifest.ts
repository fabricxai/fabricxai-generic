import type { MetadataRoute } from 'next'

/**
 * The install manifest (mobile contract §2, plan 4.1).
 *
 * What makes the app installable — a storekeeper opens the factory's URL, taps install,
 * and it sits on the home screen. `standalone` so the installed app loses the browser
 * chrome; start at `/` so the existing landing logic sends each role to its own screen,
 * exactly as a browser visit would. Per-skin start URLs come with the skins (4.2+).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FabricXAI',
    short_name: 'FabricXAI',
    description: 'The factory, in your pocket — receive, count, inspect, approve.',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf8f4',
    theme_color: '#181d29',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
