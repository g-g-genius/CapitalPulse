import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '登录 / 注册 · A · Flow',
  description: '登录 CapitalPulse 资金研究工作台',
}

export default function LoginLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}
