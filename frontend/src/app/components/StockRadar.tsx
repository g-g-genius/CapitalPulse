'use client'

import { Activity, ArrowUpRight, Clock3, Radar, Radio } from 'lucide-react'
import { useEffect, useState } from 'react'

type StockRadarItem = {
  quote_id: string
  code: string
  name: string
  market_name: string
  source_time: number
  main_net: number
  price: number | null
  change_percent: number | null
  amount: number | null
  change_scan: number | null
  window_seconds: number | null
  change_1m: number | null
  change_3m: number | null
  turned_positive: boolean
  turn_time: number | null
  points: [number, number][]
}

type StockRadarData = {
  market_status: string
  source_time: number | null
  source_age_seconds: number | null
  scanning: boolean
  scan: { pages_completed?: number; pages_total?: number; received?: number }
  next_scan_at: number | null
  last_success_at: string | null
  universe_count: number
  scanned_count: number
  poll_seconds: number
  last_error: string | null
  turns: StockRadarItem[]
  rising: StockRadarItem[]
  falling: StockRadarItem[]
}

function amount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${(value / 1e8).toFixed(2)}亿`
}

function clock(value: number | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value * 1000))
}

function Sparkline({ points }: { points: [number, number][] }) {
  if (points.length < 2) return <p className="py-8 text-center text-xs text-slate-500">积累数据后显示资金轨迹</p>
  const values = points.map((point) => point[1])
  const low = Math.min(...values)
  const span = Math.max(1, Math.max(...values) - low)
  const duration = Math.max(1, points[points.length - 1][0] - points[0][0])
  const path = points.map(([stamp, value], index) => `${index ? 'L' : 'M'} ${((stamp - points[0][0]) / duration * 280).toFixed(1)} ${(70 - (value - low) / span * 64).toFixed(1)}`).join(' ')
  return <svg viewBox="0 0 280 76" className="h-20 w-full" role="img" aria-label="最近五分钟主力资金走势"><path d={path} fill="none" stroke="currentColor" strokeWidth="2" className={values.at(-1)! >= values[0] ? 'text-red-600' : 'text-emerald-600'} /></svg>
}

export default function StockRadar({
  active,
  onOpenStock,
}: {
  active: boolean
  onOpenStock: (stock: { quote_id: string; code: string; name: string; market_name: string; pinyin: string }) => void
}) {
  const [data, setData] = useState<StockRadarData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [receivedAt, setReceivedAt] = useState(0)
  const [focusedCode, setFocusedCode] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let disposed = false
    let inFlight = false
    let controller: AbortController | null = null
    const poll = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      controller = new AbortController()
      const deadline = window.setTimeout(() => controller?.abort(), 10000)
      try {
        const response = await fetch('/api/finance/stock-radar', { cache: 'no-store', signal: controller.signal })
        const payload = await response.json()
        if (!response.ok || payload.code !== 200 || !payload.data) {
          throw new Error(payload.msg || '个股异动加载失败')
        }
        if (!disposed) { setData(payload.data as StockRadarData); setReceivedAt(Date.now()); setTick(Date.now()); setError(null) }
      } catch (cause) {
        if (!disposed) setError(controller?.signal.aborted ? '请求超时，正在重试' : cause instanceof Error ? cause.message : '个股异动加载失败')
      } finally {
        window.clearTimeout(deadline)
        inFlight = false
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 5000)
    const ageTimer = window.setInterval(() => setTick(Date.now()), 1000)
    const onVisibility = () => { if (document.visibilityState === 'visible') { setTick(Date.now()); void poll() } }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      controller?.abort()
      window.clearInterval(timer)
      window.clearInterval(ageTimer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])

  if (!active) return null
  const groups = [
    { title: '由负转正', description: '最近 5 分钟内跨过零轴', items: data?.turns ?? [] },
    { title: '本轮流入增加', description: '与上一轮完整扫描比较', items: data?.rising ?? [] },
    { title: '本轮流出增加', description: '与上一轮完整扫描比较', items: data?.falling ?? [] },
  ]
  const stocks = [...(data?.turns ?? []), ...(data?.rising ?? []), ...(data?.falling ?? [])]
  const focused = stocks.find((stock) => stock.quote_id === focusedCode) ?? stocks[0]
  const localAge = (data?.source_age_seconds ?? Infinity) + Math.max(0, tick - receivedAt) / 1000
  const connectionDelayed = receivedAt > 0 && tick - receivedAt > 15000
  const isLive = data?.market_status === 'open' && !error && !connectionDelayed && localAge <= 75
  const delayed = data?.market_status === 'stale' || (data?.market_status === 'open' && !isLive)

  return <div className="min-h-[560px] bg-slate-50/70 p-4 dark:bg-slate-950/40">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
      <span className="inline-flex items-center gap-1.5"><Radio size={14} />全市场沪深京 A 股 · 已取得 {data?.scanned_count ?? 0} / {data?.universe_count ?? 0} 只有效快照 · 约 {data?.poll_seconds ?? 60} 秒扫描</span>
      <span className="inline-flex items-center gap-1"><Clock3 size={13} />源时间 {clock(data?.source_time ?? null)} · {isLive ? '实时' : data?.market_status === 'closed' ? '已休市' : data?.market_status === 'lunch' ? '午间休市' : data?.market_status === 'preopen' ? '尚未开盘' : '数据延迟'}</span>
    </div>
    {(error || data?.last_error || delayed) && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">{error || data?.last_error || '上游源时间已过期，等待下一次完整扫描'}；已显示的结果仅供回看，暂停实时判断。</p>}
    {data?.scan?.pages_total !== undefined && <p className="mb-3 text-xs text-slate-500" role="status">{data.scanning ? '正在扫描' : '最近一次扫描'}：{data.scan.pages_completed ?? 0}/{data.scan.pages_total || '—'} 页 · 已接收 {data.scan.received ?? 0} 只{data.next_scan_at && !data.scanning && data.market_status !== 'closed' ? ` · 下次尝试 ${clock(data.next_scan_at)}` : ''}</p>}
    {!data && !error && <div className="radar-empty"><Activity size={32} /><h3>正在读取个股异动</h3><p>积累至少两次完整市场快照后显示本轮变化。</p></div>}
    {data && stocks.length === 0 && <div className="radar-empty"><Radar size={36} /><h3>{data.market_status === 'closed' ? '休市期间暂停个股扫描' : '等待有效异动'}</h3><p>只展示源时间有效、完成全市场扫描且有短时资金变化的股票。</p></div>}
    {stocks.length > 0 && <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid gap-4 lg:grid-cols-3">
        {groups.map((group) => <section key={group.title} className="min-w-0 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800"><h3 className="text-sm font-semibold">{group.title}</h3><p className="mt-0.5 text-xs text-slate-500">{group.description}</p></div>
          <div className="max-h-[550px] overflow-y-auto p-2">
            {group.items.length === 0 && <p className="p-3 text-xs text-slate-500">暂无符合条件的股票</p>}
            {group.items.map((stock) => <button type="button" key={stock.quote_id} onClick={() => setFocusedCode(stock.quote_id)} className={`mb-1 w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 ${focused?.quote_id === stock.quote_id ? 'border-slate-400 bg-slate-50 dark:border-slate-500 dark:bg-slate-800' : 'border-transparent'}`}>
              <div className="flex items-center justify-between gap-2 text-sm"><span className="truncate font-medium">{stock.name}</span><span className="shrink-0 font-mono text-xs text-slate-500">{stock.code}</span></div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs"><span className={stock.change_scan !== null && stock.change_scan >= 0 ? 'text-red-600' : 'text-emerald-600'}>本轮 {amount(stock.change_scan)}</span><span className="text-slate-500">{stock.change_percent === null ? '—' : `${stock.change_percent >= 0 ? '+' : ''}${stock.change_percent.toFixed(2)}%`}</span></div>
            </button>)}
          </div>
        </section>)}
      </div>
      <aside className="self-start rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        {focused && <>
          <div className="flex items-start justify-between gap-2"><div><p className="text-xs text-slate-500">当前观察个股 · {focused.market_name}</p><h3 className="mt-1 text-lg font-semibold">{focused.name} <span className="font-mono text-sm font-normal text-slate-500">{focused.code}</span></h3></div>{focused.turned_positive && <span className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-950/50">由负转正</span>}</div>
          <div className={`mt-3 font-mono text-2xl font-semibold ${focused.main_net >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{amount(focused.main_net)}</div>
          <p className="mt-1 text-xs text-slate-500">当日累计主力净流入 · 现价 {focused.price === null ? '—' : `¥${focused.price.toFixed(2)}`}</p>
          <div className="mt-5 grid grid-cols-3 gap-2 text-xs">{([[`本轮${focused.window_seconds === null ? '' : ` ${focused.window_seconds}秒`}`, focused.change_scan], ['1 分钟', focused.change_1m], ['3 分钟', focused.change_3m]] as const).map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800"><div className="text-slate-500">{label}变化</div><div className={`mt-1 font-mono font-semibold ${value === null ? 'text-slate-400' : value >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{amount(value)}</div></div>)}</div>
          <div className="mt-5 border-t border-slate-100 pt-3 dark:border-slate-800"><p className="mb-2 text-xs text-slate-500">最近 5 分钟主力资金轨迹</p><Sparkline points={focused.points} /><p className="mt-1 text-right text-[11px] text-slate-500">源时间 {clock(focused.source_time)}</p></div>
          <button type="button" onClick={() => onOpenStock({ quote_id: focused.quote_id, code: focused.code, name: focused.name, market_name: focused.market_name, pinyin: '' })} className="mt-4 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">查看个股资金曲线 <ArrowUpRight size={14} /></button>
        </>}
      </aside>
    </div>}
    <p className="mt-4 text-[11px] leading-5 text-slate-500">异动按东方财富主力净流入与上一轮完整扫描的变化排序，实际间隔见右侧；交易稀疏、停牌或源时间过期的股票不会显示。资金变化仅供观察。</p>
  </div>
}
