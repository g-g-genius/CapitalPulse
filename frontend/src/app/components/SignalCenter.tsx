'use client'

import { Activity, ArrowUpRight, Bell, BellRing, CalendarDays, Clock3, Radio, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type SignalEvent = {
  id?: number
  trade_date: string
  source_time: number
  entity_type: 'sector' | 'stock'
  entity_code: string
  entity_name: string
  signal_type: 'turn_positive' | 'surge'
  main_net: number
  change_15s: number | null
  change_1m: number | null
  change_3m: number | null
  after_1m?: number | null
  after_3m?: number | null
}

type ReplayData = {
  trade_date: string
  snapshot_count: number
  sector_count: number
  stock_count: number
  total_events: number
  events: SignalEvent[]
}

type Sensitivity = 'fast' | 'steady'
type SignalSettings = { sensitivity: Sensitivity; sound: boolean; desktop: boolean }

const SETTINGS_KEY = 'capitalpulse.signal-settings'
const DEFAULT_SETTINGS: SignalSettings = { sensitivity: 'fast', sound: false, desktop: false }

function cstDate(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function formatAmount(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${(value / 1e8).toFixed(2)}亿`
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp * 1000))
}

function matchesSensitivity(event: SignalEvent, sensitivity: Sensitivity): boolean {
  if (sensitivity === 'fast') return true
  const threshold = event.entity_type === 'sector' ? 12_000_000 : 3_000_000
  return (event.change_15s ?? 0) >= threshold && (event.change_1m == null || event.change_1m > 0)
}

export default function SignalCenter({
  active,
  onOpenSector,
  onOpenStock,
  canOpenSector,
  marketStatus,
  lastSectorSource,
}: {
  active: boolean
  onOpenSector: (code: string) => void
  onOpenStock: (event: SignalEvent) => void
  canOpenSector: (code: string) => boolean
  marketStatus: string
  lastSectorSource: number | null
}) {
  const [events, setEvents] = useState<SignalEvent[]>([])
  const [settings, setSettings] = useState<SignalSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef(settings)
  const [mode, setMode] = useState<'live' | 'replay'>('live')
  const [replayDate, setReplayDate] = useState(cstDate)
  const [replay, setReplay] = useState<ReplayData | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [monitoredStocks, setMonitoredStocks] = useState(0)
  const [stockPollError, setStockPollError] = useState<string | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [toast, setToast] = useState<SignalEvent | null>(null)
  const currentDate = useRef(cstDate())
  const cursor = useRef(0)
  const initialized = useRef(false)
  const audioRef = useRef<AudioContext | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<SignalSettings>
        setSettings({
          sensitivity: saved.sensitivity === 'steady' ? 'steady' : 'fast',
          sound: saved.sound === true,
          desktop: saved.desktop === true,
        })
      }
    } catch { /* Browser storage is optional. */ }
  }, [])

  useEffect(() => {
    settingsRef.current = settings
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* Keep in memory. */ }
  }, [settings])

  const playSound = useCallback(() => {
    try {
      const audio = audioRef.current ?? new AudioContext()
      audioRef.current = audio
      void audio.resume()
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(760, audio.currentTime)
      oscillator.frequency.exponentialRampToValueAtTime(1040, audio.currentTime + 0.13)
      gain.gain.setValueAtTime(0.025, audio.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.17)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start()
      oscillator.stop(audio.currentTime + 0.18)
    } catch { /* Some browsers block audio until the user interacts with the page. */ }
  }, [])

  useEffect(() => {
    let disposed = false
    let inFlight = false
    let controller: AbortController | null = null
    let generation = 0
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      controller = new AbortController()
      const deadline = window.setTimeout(() => controller?.abort(), 10000)
      const requestGeneration = generation
      const day = cstDate()
      if (currentDate.current !== day) {
        currentDate.current = day
        cursor.current = 0
        initialized.current = false
        setEvents([])
      }
      try {
        const response = await fetch(`/api/finance/signals/recent?trade_date=${day}&since_id=${cursor.current}&limit=200`, {
          cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        })
        const payload = await response.json()
        if (!response.ok || payload.code !== 200 || !Array.isArray(payload.data?.events)) {
          throw new Error(payload.msg || '提醒列表读取失败')
        }
        if (disposed || requestGeneration !== generation) return
        const incoming = payload.data.events as SignalEvent[]
        setMonitoredStocks(Number(payload.data.monitored_stocks) || 0)
        setStockPollError(payload.data.stock_poll_error || null)
        setPersistError(payload.data.persist_error || null)
        setPollError(null)
        if (!initialized.current) {
          setEvents(incoming)
          initialized.current = true
        } else if (incoming.length) {
          setEvents((current) => {
            const byId = new Map([...incoming, ...current].map((event) => [event.id, event]))
            return [...byId.values()].sort((left, right) => (right.id ?? 0) - (left.id ?? 0)).slice(0, 200)
          })
          const matching = incoming.filter((event) =>
            matchesSensitivity(event, settingsRef.current.sensitivity)
            && Date.now() / 1000 - event.source_time <= 30
            && Date.now() / 1000 - event.source_time >= -5,
          )
          if (matching.length) {
            const latest = matching.reduce((left, right) => left.source_time > right.source_time ? left : right)
            setToast(latest)
            if (toastTimer.current) clearTimeout(toastTimer.current)
            toastTimer.current = setTimeout(() => setToast(null), 7000)
            if (settingsRef.current.sound) playSound()
            if (settingsRef.current.desktop && 'Notification' in window && Notification.permission === 'granted') {
              for (const event of matching.slice(0, 3)) {
                try {
                  const label = event.signal_type === 'surge' ? '资金加速' : '由负转正'
                  const notification = new Notification(`${event.entity_name} · ${label}`, {
                    body: `15 秒 ${formatAmount(event.change_15s)} · ${formatClock(event.source_time)}`,
                    tag: `capitalpulse-${event.entity_type}-${event.entity_code}-${event.signal_type}`,
                  })
                  notification.onclick = () => { window.focus(); window.location.hash = 'signals'; notification.close() }
                } catch { /* Permission can change while the page is open. */ }
              }
            }
          }
        }
        cursor.current = Math.max(cursor.current, ...incoming.map((event) => event.id ?? 0))
      } catch (error) {
        if (!disposed && requestGeneration === generation) setPollError(error instanceof Error ? error.message : '提醒列表读取失败')
      } finally {
        window.clearTimeout(deadline)
        inFlight = false
      }
    }
    void poll()
    const interval = setInterval(() => { void poll() }, 5000)
    const onVisibility = () => { if (document.visibilityState === 'visible') void poll() }
    const onAuthChange = () => {
      generation += 1
      controller?.abort()
      cursor.current = 0
      initialized.current = false
      setEvents([])
      setReplay(null)
      setToast(null)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('capitalpulse:auth-changed', onAuthChange)
    return () => {
      disposed = true
      controller?.abort()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('capitalpulse:auth-changed', onAuthChange)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [playSound])

  const enableDesktop = async () => {
    setPermissionError(null)
    if (settings.desktop) {
      setSettings((current) => ({ ...current, desktop: false }))
      return
    }
    if (!('Notification' in window) || !window.isSecureContext) {
      setPermissionError('当前浏览器环境不支持桌面通知。')
      return
    }
    const permission = await Notification.requestPermission()
    if (permission === 'granted') setSettings((current) => ({ ...current, desktop: true }))
    else setPermissionError('浏览器未授予通知权限，可继续使用页面提醒。')
  }

  const runReplay = async () => {
    setReplayLoading(true)
    setReplayError(null)
    try {
      const response = await fetch(`/api/finance/signals/replay?trade_date=${replayDate}`, {
        cache: 'no-store', credentials: 'same-origin',
      })
      const payload = await response.json()
      if (!response.ok || payload.code !== 200 || !payload.data) {
        throw new Error(payload.msg || '历史回放失败')
      }
      setReplay(payload.data as ReplayData)
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : '历史回放失败')
    } finally {
      setReplayLoading(false)
    }
  }

  const shown = mode === 'live' ? events.filter((event) => matchesSensitivity(event, settings.sensitivity))
    : (replay?.events ?? []).filter((event) => matchesSensitivity(event, settings.sensitivity))

  return (
    <>
      {active && <div className="signal-center">
        <div className="signal-overview">
          <div><span><Radio size={15} /> 实时信号</span><strong>{events.length}</strong><small>今日记录，页面开启时接收提醒</small></div>
          <div><span><Activity size={15} /> 自选股监测</span><strong>{monitoredStocks}</strong><small>已合并相同股票的采集请求</small></div>
          <div><span><Clock3 size={15} /> 板块源数据</span><strong>{lastSectorSource ? formatClock(lastSectorSource) : '—'}</strong><small>{marketStatus === 'open' ? '交易中 · 按上游源时间判断' : marketStatus === 'closed' ? '已休市 · 保留最近快照' : `状态：${marketStatus}`}</small></div>
        </div>

        <div className="signal-controls">
          <div><h3>提醒设置</h3><p>灵敏模式关注短时变化；稳健模式提高 15 秒资金增量门槛。仅影响你的页面提醒和列表筛选。</p></div>
          <div className="signal-control-actions">
            <div className="signal-segmented" role="group" aria-label="提醒灵敏度">
              <button type="button" aria-pressed={settings.sensitivity === 'fast'} onClick={() => setSettings((current) => ({ ...current, sensitivity: 'fast' }))}>灵敏</button>
              <button type="button" aria-pressed={settings.sensitivity === 'steady'} onClick={() => setSettings((current) => ({ ...current, sensitivity: 'steady' }))}>稳健</button>
            </div>
            <button type="button" className="signal-toggle" aria-pressed={settings.sound} onClick={() => { setSettings((current) => ({ ...current, sound: !current.sound })); if (!settings.sound) playSound() }}>{settings.sound ? <Volume2 size={15} /> : <VolumeX size={15} />}声音</button>
            <button type="button" className="signal-toggle" aria-pressed={settings.desktop} onClick={() => void enableDesktop()}>{settings.desktop ? <BellRing size={15} /> : <Bell size={15} />}桌面通知</button>
          </div>
        </div>
        {(permissionError || persistError || stockPollError || pollError) && <p className="signal-warning" role="status">{permissionError || (persistError ? `提醒记录暂不可用：${persistError}` : stockPollError ? `自选股采集暂不可用：${stockPollError}` : pollError)}</p>}
        {(marketStatus === 'stale' || marketStatus === 'error') && <p className="signal-warning" role="status">板块源数据延迟或异常，实时板块提醒暂停；恢复最新快照后自动继续。</p>}

        <div className="signal-list-head">
          <div className="signal-segmented" role="tablist" aria-label="信号记录">
            <button type="button" role="tab" aria-selected={mode === 'live'} onClick={() => setMode('live')}>实时记录</button>
            <button type="button" role="tab" aria-selected={mode === 'replay'} onClick={() => setMode('replay')}>历史回放</button>
          </div>
          {mode === 'replay' && <div className="signal-replay-tools"><CalendarDays size={15} /><input type="date" value={replayDate} max={cstDate()} onChange={(event) => { setReplayDate(event.target.value); setReplay(null) }} aria-label="回放交易日" /><button type="button" onClick={() => void runReplay()} disabled={replayLoading || !replayDate}>{replayLoading ? '计算中…' : '开始回放'}</button></div>}
          {mode === 'live' && <span className="signal-live-tag"><i />每 5 秒更新</span>}
        </div>
        {mode === 'replay' && replay && <p className="signal-replay-summary">{replay.trade_date} · 使用 {replay.snapshot_count.toLocaleString()} 条已保存快照，覆盖 {replay.sector_count} 个板块、{replay.stock_count} 只当前自选股，共模拟 {replay.total_events} 条信号。1 分钟和 3 分钟后变化仅在有后续快照时显示。</p>}
        {replayError && <p className="signal-warning" role="status">{replayError}</p>}
        {shown.length === 0 && <div className="signal-empty"><Bell size={27} /><h3>{mode === 'replay' ? '选择交易日并开始回放' : '暂无符合当前灵敏度的信号'}</h3><p>{mode === 'replay' ? '历史回放按已保存的实时快照重新计算，未保存的秒级变化无法补出。' : '交易时段会持续监测全行业和已加入自选的股票。'}</p></div>}
        {shown.length > 0 && <div className="signal-feed" aria-label={mode === 'live' ? '今日异动记录' : '历史模拟信号'}>
          {shown.map((event, index) => (
            <div className="signal-feed-row" key={`${event.entity_type}-${event.entity_code}-${event.signal_type}-${event.source_time}-${index}`}>
              <span className={`signal-kind ${event.signal_type === 'turn_positive' ? 'is-turn' : ''}`}>{event.signal_type === 'turn_positive' ? '由负转正' : '资金加速'}</span>
              <div className="signal-feed-main"><strong>{event.entity_name}</strong><span>{event.entity_type === 'sector' ? '行业板块' : '自选股'} · {formatClock(event.source_time)} · {event.entity_code}</span></div>
              <div className="signal-feed-metrics"><span>15秒 <b>{formatAmount(event.change_15s)}</b></span><span>1分钟 <b>{formatAmount(event.change_1m)}</b></span><span>3分钟 <b>{formatAmount(event.change_3m)}</b></span></div>
              {mode === 'replay' && <div className="signal-feed-outcome"><span>后1分钟 {formatAmount(event.after_1m)}</span><span>后3分钟 {formatAmount(event.after_3m)}</span></div>}
              {(event.entity_type === 'stock' || canOpenSector(event.entity_code)) && <button type="button" className="signal-open" onClick={() => event.entity_type === 'sector' ? onOpenSector(event.entity_code) : onOpenStock(event)} aria-label={`查看${event.entity_name}资金走势`}><ArrowUpRight size={16} /></button>}
            </div>
          ))}
        </div>}
        <p className="signal-footnote">资金流变化用于观察，不代表买卖建议。声音与桌面通知仅在工作台页面打开时触发；历史回放不会触发通知。</p>
      </div>}
      {toast && <button type="button" className="signal-toast" onClick={() => { window.location.hash = 'signals'; setToast(null) }}><BellRing size={18} /><span><strong>{toast.entity_name} · {toast.signal_type === 'surge' ? '资金加速' : '由负转正'}</strong><small>15 秒 {formatAmount(toast.change_15s)} · {formatClock(toast.source_time)}</small></span><X size={14} /></button>}
    </>
  )
}
