import type { Metadata, Viewport } from 'next'
import { Anek_Bangla, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google'

import { THEME_BOOTSTRAP } from '@/components/shell/theme-toggle'
import { requestLocale } from '@/lib/ui-locale'

import './globals.css'

import { PwaRegistration } from '@/components/shell/pwa'

// UI and headings, 400/500/600/700 per the type scale.
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jakarta',
  display: 'swap',
})

// Code, IDs, metrics and eyebrow labels — and every identifier on Bengali screens.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

// Floor staff run the app in Bangla. Anek Bangla shares Jakarta's optical size,
// so the two sit at identical px values. Never above 600 — see theme.css.
const anekBangla = Anek_Bangla({
  subsets: ['bengali'],
  weight: ['400', '500', '600'],
  variable: '--font-anek-bangla',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'FabricXAI',
  description: 'AI-powered ERP for garment export factories',
  icons: { icon: '/brand/marbim-logo-onwhite.png' },
}

export const viewport: Viewport = {
  themeColor: '#FBFAF8',
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // `lang` is the document's, so it has to be resolved this high up: it is what a screen
  // reader announces in and what the browser hyphenates by, and Bangla announced as English
  // is worse than untranslated English.
  const locale = await requestLocale()

  return (
    <html
      lang={locale}
      // Light-first: every screen is designed in light mode. Dark is opt-in per
      // subtree (the wall board, the owner night view) by setting data-theme there.
      data-theme="light"
      // THEME_BOOTSTRAP rewrites `data-theme` on this element before React hydrates —
      // that is the whole point of it, and it is what stops a dark-mode user seeing a
      // light flash. React then finds an attribute that disagrees with the server HTML
      // and reports a hydration mismatch on every dark-mode page load. Suppressed here
      // because the difference is intended; it applies to THIS element only, so a real
      // mismatch anywhere inside the tree is still reported.
      suppressHydrationWarning
      // `density` switches row heights and tap targets for shared floor tablets.
      data-density="desk"
      className={`${jakarta.variable} ${jetbrainsMono.variable} ${anekBangla.variable}`}
    >
      <head>
        {/* Applies the stored mode before first paint, so a dark-mode user
            never sees a light flash on the way in. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body><PwaRegistration />
        {children}</body>
    </html>
  )
}
