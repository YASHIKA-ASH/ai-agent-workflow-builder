'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { nhost } from '@/lib/nhost'
import { useAuth } from '@/components/AuthProvider'

export default function LoginPage() {
  const { session, loading } = useAuth()
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('owner.a@example.com')
  const [password, setPassword] = useState('DemoPass123!')
  const [name, setName] = useState('Demo User')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!loading && session) router.replace('/')
  }, [loading, session, router])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'signin') {
        await nhost.auth.signInEmailPassword({ email, password })
      } else {
        await nhost.auth.signUpEmailPassword({ email, password, options: { displayName: name } })
      }
      router.replace('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-hero">
        <div className="logo-mark">AF</div>
        <h1>AgentFlow</h1>
        <p>Build, run, pause, approve, and observe AI agent workflows with organization-scoped permissions.</p>
        <div className="security-points">
          <span>✓ Org isolation</span><span>✓ Step-level gating</span><span>✓ Live subscriptions</span><span>✓ Quota enforcement</span>
        </div>
      </section>
      <section className="auth-card">
        <div className="tabs">
          <button className={mode === 'signin' ? 'tab active' : 'tab'} onClick={() => setMode('signin')}>Sign in</button>
          <button className={mode === 'signup' ? 'tab active' : 'tab'} onClick={() => setMode('signup')}>Sign up</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div><h2>{mode === 'signin' ? 'Welcome back' : 'Create an account'}</h2><p className="muted">Nhost email/password authentication</p></div>
          {error && <div className="alert error">{error}</div>}
          {mode === 'signup' && <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>}
          <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="button primary full" disabled={busy}>{busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Sign up'}</button>
          <div className="demo-hint">
            <strong>Seeded demo login</strong><br />owner.a@example.com / DemoPass123!
          </div>
        </form>
      </section>
    </main>
  )
}
