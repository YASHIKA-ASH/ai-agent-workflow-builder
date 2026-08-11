'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { nhost } from '@/lib/nhost'
import { useAuth } from './AuthProvider'

export default function Header() {
  const { user } = useAuth()
  const router = useRouter()

  async function signOut() {
    const session = nhost.getUserSession()
    try {
      if (session?.refreshToken) {
        await nhost.auth.signOut({ refreshToken: session.refreshToken })
      }
    } finally {
      nhost.clearSession()
      router.replace('/login')
    }
  }

  return (
    <header className="topbar">
      <Link href="/" className="brand">AgentFlow</Link>
      <div className="topbar-actions">
        <span className="muted small">{user?.email}</span>
        <button className="button secondary" onClick={signOut}>Sign out</button>
      </div>
    </header>
  )
}
