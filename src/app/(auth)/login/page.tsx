'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Card } from '@/components/fx/data'
import { useT } from '@/components/fx/locale'
import { InlineAlert } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { MarbimMark } from '@/components/fx/mark'
import { signIn } from '@/lib/auth-client'

import { loginErrorKey } from './login-error'

export default function LoginPage() {
  const t = useT()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const { error: err } = await signIn.email({ email, password })

    if (err) {
      setBusy(false)
      // Keyed on the error CODE, not the status: 403 covers several unrelated refusals and
      // only one of them is about the account. See `loginErrorKey`.
      setError(t(loginErrorKey(err)))
      return
    }

    /*
     * To the root, which resolves the landing screen from the caller's roles. This form is
     * a client component and cannot know them — naming `/approve` here sent every viewer
     * and member to a screen they cannot open, which is a poor first thing to be told.
     */
    router.push('/')
  }

  return (
    <Card padding={32}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 style={{ font: "600 26px/1.15 var(--fx-font-sans)", margin: 0 }}>{t('ui.auth.sign_in')}</h1>
          <p style={{ font: "400 15px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)', margin: 0 }}>
            {t('ui.auth.sign_in_tagline')}
          </p>
        </div>

        <TextInput
          label={t('ui.auth.email')}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextInput
          label={t('ui.auth.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

        <Button type="submit" variant="primary" size="lg" full disabled={busy}>
          {busy ? (
            <MarbimMark state="thinking" size={20} label={t('ui.auth.signing_in')} />
          ) : (
            t('ui.auth.sign_in')
          )}
        </Button>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            font: "400 14px/1.5 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
          }}
        >
          {/* First, not last: somebody reading this form twice is here because they cannot
              get in, not because they want to create a second factory. */}
          <Link href="/forgot-password">{t('ui.auth.forgot_link')}</Link>
          <span>
            {t('ui.auth.new_factory')}{' '}
            <Link href="/signup">{t('ui.auth.create_account_link')}</Link>
          </span>
        </div>
      </form>
    </Card>
  )
}
