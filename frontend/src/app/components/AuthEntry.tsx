'use client'

import { LogOut, UserRound } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

type Account = { id: number; email: string; display_name: string; role: 'member' | 'admin' }

export default function AuthEntry() {
  const [account, setAccount] = useState<Account | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/finance/auth/me', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      if (response.ok) {
        const result = await response.json()
        setAccount(result.data as Account)
      }
    }).catch(() => { /* The market workspace remains available while auth is offline. */ })
    return () => controller.abort()
  }, [])

  const logout = async () => {
    setLoggingOut(true)
    try {
      const response = await fetch('/api/finance/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('退出失败')
      setAccount(null)
      window.dispatchEvent(new Event('capitalpulse:auth-changed'))
    } catch {
      // Keep the account label visible until the server confirms logout.
    } finally {
      setLoggingOut(false)
    }
  }

  if (!account) {
    return <Link className="topbar-login" href="/login"><UserRound size={15} />登录 / 注册</Link>
  }

  return (
    <div className="topbar-account">
      <span className="topbar-avatar" aria-hidden="true">{account.display_name.slice(0, 1)}</span>
      <span className="topbar-account-name" title={account.email}>{account.display_name}</span>
      {account.role === 'admin' && <span className="topbar-account-role">管理员</span>}
      <button type="button" onClick={logout} disabled={loggingOut} aria-label="退出登录" title="退出登录">
        <LogOut size={15} />
      </button>
    </div>
  )
}
