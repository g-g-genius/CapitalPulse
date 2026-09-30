'use client'

import { FormEvent, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Activity, ArrowLeft, ArrowRight, Check, Eye, EyeOff,
  LockKeyhole, Mail, Moon, Radar, Sun, TrendingUp, UserRound,
} from 'lucide-react'
import './login.css'

type Mode = 'login' | 'register'
type Theme = 'light' | 'dark'

function readError(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = payload.detail
    if (typeof detail === 'string') return detail
  }
  return '操作失败，请稍后重试。'
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login')
  const [theme, setTheme] = useState<Theme>('dark')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    const controller = new AbortController()
    void fetch('/api/finance/auth/me', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    }).then((response) => {
      if (response.ok) window.location.replace('/')
    }).catch(() => { /* A first-time visitor has no active session. */ })
    return () => controller.abort()
  }, [])

  const changeTheme = (next: Theme) => {
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    document.documentElement.style.colorScheme = next
    try { window.localStorage.setItem('capitalpulse.theme', next) } catch { /* Keep the chosen theme for this visit. */ }
  }

  const changeMode = (next: Mode) => {
    setMode(next)
    setError('')
    setPassword('')
    setConfirmPassword('')
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致。')
      return
    }
    setPending(true)
    try {
      const response = await fetch(`/api/finance/auth/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(mode === 'register'
          ? { display_name: displayName.trim(), email: email.trim(), password }
          : { email: email.trim(), password }),
      })
      const result: unknown = await response.json()
      if (!response.ok) {
        setError(readError(result))
        return
      }
      window.location.assign('/')
    } catch {
      setError('暂时无法连接服务，请稍后重试。')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-orb auth-orb-one" aria-hidden="true" />
      <div className="auth-orb auth-orb-two" aria-hidden="true" />
      <div className="auth-layout">
        <section className="auth-visual" aria-label="CapitalPulse 介绍">
          <div className="auth-visual-top">
            <Link href="/" className="auth-brand" aria-label="返回 A · Flow 工作台">
              <span className="auth-brand-icon"><Activity size={23} strokeWidth={2.3} /></span>
              <span><strong>A · Flow</strong><small>CAPITALPULSE</small></span>
            </Link>
            <span className="auth-visual-version">MARKET INTELLIGENCE / 01</span>
          </div>

          <div className="auth-hero">
            <span className="auth-kicker"><span />你的资金研究工作台</span>
            <h1>看见资金流动，<br /><em>把握市场节奏。</em></h1>
            <p>追踪板块轮动与短时异动，把每一条资金曲线变成更清晰的观察线索。</p>
          </div>

          <div className="auth-preview" aria-hidden="true">
            <div className="auth-preview-head"><span><i />MARKET FLOW</span><span>资金走势 · 界面示意</span></div>
            <div className="auth-preview-stats">
              <span>板块资金动向<strong>实时观察</strong></span>
              <span><TrendingUp size={13} />动态追踪</span>
            </div>
            <svg viewBox="0 0 550 220" preserveAspectRatio="none">
              <defs>
                <linearGradient id="authArea" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#8b99ff" stopOpacity=".22" /><stop offset="1" stopColor="#8b99ff" stopOpacity="0" /></linearGradient>
                <linearGradient id="authLine" x1="0" x2="1"><stop stopColor="#7689ff" /><stop offset="1" stopColor="#77e0cb" /></linearGradient>
              </defs>
              <path className="auth-grid-line" d="M0 46H550 M0 101H550 M0 156H550 M0 211H550" />
              <path fill="url(#authArea)" d="M0 183 L24 175 45 178 68 154 91 159 116 149 138 165 163 149 187 134 209 143 232 125 254 131 278 117 302 122 326 89 348 99 374 78 395 88 421 61 444 69 468 48 491 57 516 32 550 36 V220 H0Z" />
              <path className="auth-line-primary" d="M0 183 L24 175 45 178 68 154 91 159 116 149 138 165 163 149 187 134 209 143 232 125 254 131 278 117 302 122 326 89 348 99 374 78 395 88 421 61 444 69 468 48 491 57 516 32 550 36" stroke="url(#authLine)" />
              <path className="auth-line-secondary" d="M0 170 L28 179 54 169 82 181 108 174 135 189 161 181 188 194 218 175 247 184 272 170 298 182 326 169 354 177 383 162 411 171 440 154 468 164 498 151 522 155 550 140" />
              <circle cx="516" cy="32" r="5" fill="#80dccb" stroke="#1b2941" strokeWidth="4" />
            </svg>
            <div className="auth-preview-axis"><span>09:30</span><span>10:30</span><span>11:30 / 13:00</span><span>14:00</span><span>15:00</span></div>
          </div>

          <div className="auth-visual-bottom">
            <span><Radar size={15} />板块异动</span><span><Activity size={15} />资金曲线</span><span><Check size={15} />个股追踪</span>
          </div>
        </section>

        <section className="auth-form-side" aria-label="账号登录">
          <div className="auth-form-top">
            <Link href="/" className="auth-back"><ArrowLeft size={15} />返回工作台</Link>
            <div className="auth-theme" role="group" aria-label="界面主题">
              <button type="button" onClick={() => changeTheme('light')} aria-pressed={theme === 'light'} aria-label="浅色主题"><Sun size={15} /></button>
              <button type="button" onClick={() => changeTheme('dark')} aria-pressed={theme === 'dark'} aria-label="深色主题"><Moon size={15} /></button>
            </div>
          </div>

          <div className="auth-form-wrap">
            <div className="auth-form-heading">
              <div className="auth-form-mark"><LockKeyhole size={20} /></div>
              <span className="auth-form-eyebrow">WELCOME TO A · FLOW</span>
              <h2>{mode === 'login' ? '欢迎回来' : '创建你的账号'}<span>.</span></h2>
              <p>{mode === 'login' ? '登录后继续使用你的资金研究工作台。' : '创建账号，开始你的市场观察。'}</p>
            </div>

            <div className="auth-tabs" role="tablist" aria-label="账号操作">
              <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => changeMode('login')}>登录</button>
              <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => changeMode('register')}>注册账号</button>
            </div>

            <form className="auth-form" onSubmit={submit}>
              {mode === 'register' && (
                <label className="auth-field"><span>昵称</span><div><UserRound size={17} /><input type="text" name="displayName" autoComplete="nickname" placeholder="如何称呼你" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={40} required /></div></label>
              )}
              <label className="auth-field"><span>邮箱地址</span><div><Mail size={17} /><input type="email" name="email" autoComplete="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required /></div></label>
              <label className="auth-field"><span>密码</span><div><LockKeyhole size={17} /><input type={showPassword ? 'text' : 'password'} name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'register' ? '至少 12 个字符' : '输入密码'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={mode === 'register' ? 12 : 1} maxLength={128} required /><button type="button" className="auth-reveal" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
              {mode === 'register' && (
                <label className="auth-field"><span>确认密码</span><div><LockKeyhole size={17} /><input type={showPassword ? 'text' : 'password'} name="confirmPassword" autoComplete="new-password" placeholder="再次输入密码" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} maxLength={128} required /></div></label>
              )}
              {error && <p className="auth-error" role="alert">{error}</p>}
              <button className="auth-submit" type="submit" disabled={pending}>{pending ? '正在处理…' : mode === 'login' ? '登录工作台' : '创建账号'}<ArrowRight size={18} /></button>
            </form>

            <p className="auth-switch">{mode === 'login' ? '还没有账号？' : '已经有账号？'} <button type="button" onClick={() => changeMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? '立即注册' : '去登录'}</button></p>
          </div>
          <div className="auth-form-footer"><span>© CapitalPulse</span><span>专注资金，洞察轮动</span></div>
        </section>
      </div>
    </main>
  )
}
