'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { nhost } from '@/lib/nhost'

type Session = ReturnType<typeof nhost.getUserSession>

type AuthValue = {
  session: Session
  user: NonNullable<Session>['user'] | null
  loading: boolean
}

const AuthContext = createContext<AuthValue>({ session: null, user: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setSession(nhost.getUserSession())
    setLoading(false)
    const unsubscribe = nhost.sessionStorage.onChange((next) => {
      setSession(next)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  const value = useMemo<AuthValue>(() => ({
    session,
    user: session?.user || null,
    loading,
  }), [session, loading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
