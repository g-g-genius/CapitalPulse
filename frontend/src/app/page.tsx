'use client'

// CapitalPulse market research workspace.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BarSeriesOption,
  ECharts,
  EChartsOption,
  EffectScatterSeriesOption,
  LineSeriesOption,
  ScatterSeriesOption,
} from 'echarts'
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Layers3,
  LayoutDashboard,
  Moon,
  Radio,
  Radar,
  Search,
  Sun,
} from 'lucide-react'

type Flow = {
  sector_code: string
  sector_name: string
  source_time: number
  received_at?: string
  main_net: number
  small_net: number
  mid_net: number
  large_net: number
  super_large_net: number
  granularity?: 'realtime' | 'minute_backfill'
}

type Selection = {
  rank: number
  sector_code: string
  sector_name: string
  market_cap: number
}

type SectorSeries = {
  rank: number
  sector_code: string
  sector_name: string
  points: [number, number][]
}

type DetailPoint = [number, number, number, number, number, number]

type DetailSectorSeries = {
  rank: number
  sector_code: string
  sector_name: string
  points: DetailPoint[]
}

type DetailHistoryPage = {
  trade_date: string
  page: number
  page_size: number
  total_items: number
  total_pages: number
  series: DetailSectorSeries[]
}

type DailyPoint = [string, number, number, number, number, number]

type DailySectorSeries = {
  rank: number
  sector_code: string
  sector_name: string
  points: DailyPoint[]
}

type DailyHistoryData = {
  selection_date: string | null
  interval: '1d'
  value_type: 'daily_net'
  days: number
  page: number
  page_size: number
  total_items: number
  total_pages: number
  failed_codes: string[]
  refresh_failed_codes?: string[]
  series: DailySectorSeries[]
}

type StockSearchResult = {
  quote_id: string
  code: string
  name: string
  market_name: string
  pinyin: string
}

type SectorStockCandidate = StockSearchResult & {
  price: number
  change_percent: number
  amount: number
  turnover_rate: number
  main_net: number
  volume_ratio: number | null
  source_time: number
}

type SectorCandidateData = {
  sector_code: string
  as_of: number | null
  total_constituents: number
  scanned_constituents: number
  candidates: SectorStockCandidate[]
  stale: boolean
}

const DEFAULT_STOCK: StockSearchResult = {
  quote_id: '0.000001',
  code: '000001',
  name: '平安银行',
  market_name: '深A',
  pinyin: 'PAYH',
}
const STOCK_SELECTION_STORAGE_KEY = 'capitalpulse.stock-flow.selection'
const STOCK_RECENTS_STORAGE_KEY = 'capitalpulse.stock-flow.recents'
const MAX_RECENT_STOCKS = 20

function rememberStock(recent: StockSearchResult[], stock: StockSearchResult): StockSearchResult[] {
  return [stock, ...recent.filter((item) => item.quote_id !== stock.quote_id)]
    .slice(0, MAX_RECENT_STOCKS)
}

function parseRecentStocks(value: unknown): StockSearchResult[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item): StockSearchResult[] => {
    if (
      !item || typeof item !== 'object'
      || typeof item.quote_id !== 'string'
      || typeof item.code !== 'string'
      || typeof item.name !== 'string'
      || !item.quote_id || !item.code || !item.name
      || seen.has(item.quote_id)
    ) return []
    seen.add(item.quote_id)
    return [{
      quote_id: item.quote_id,
      code: item.code,
      name: item.name,
      market_name: typeof item.market_name === 'string' ? item.market_name : '',
      pinyin: typeof item.pinyin === 'string' ? item.pinyin : '',
    }]
  }).slice(0, MAX_RECENT_STOCKS)
}

type StockFlowSession = {
  runtime_id: string
  default_stock: StockSearchResult
}

type StockFlowHistory = {
  runtime_id: string
  trade_date: string
  stock: { quote_id: string; code: string; name: string }
  points: DetailPoint[]
  poll_seconds: number
  market_status: ServiceStatus['market_status']
}

type StockSocketMessage =
  | { type: 'snapshot'; data: StockFlowHistory }
  | { type: 'update'; data: Flow & { quote_id: string; code: string; name: string } }
  | { type: 'status' | 'heartbeat'; data: { market_status: ServiceStatus['market_status'] } }

function mergeDailyHistory(
  current: DailyHistoryData | null,
  incoming: DailyHistoryData,
): DailyHistoryData {
  if (!current || current.selection_date !== incoming.selection_date) return incoming

  const previousByCode = new Map(
    current.series.map((series) => [series.sector_code, series]),
  )
  const series = incoming.series.map((nextSeries) => {
    const previous = previousByCode.get(nextSeries.sector_code)
    return nextSeries.points.length === 0 && previous?.points.length
      ? previous
      : nextSeries
  })

  return {
    ...incoming,
    failed_codes: series
      .filter((item) => item.points.length === 0)
      .map((item) => item.sector_code),
    series,
  }
}

type ChartMode = 'main' | 'radar' | 'detail' | 'daily' | 'stock'
type Theme = 'light' | 'dark'
const ThemeContext = createContext<Theme>('dark')
const CHART_THEMES = {
  dark: { muted: '#7e8ba0', axis: '#344052', grid: '#2b3544', surface: '#171e29', text: '#e5eaf3', positive: '#f07988', negative: '#50c8a3' },
  light: { muted: '#7a879b', axis: '#d7dfe9', grid: '#e1e7ef', surface: '#ffffff', text: '#273246', positive: '#da4a60', negative: '#168865' },
}

const WORKSPACE_VIEWS = [
  { id: 'main', label: '资金总览', description: '观察资金方向，跟踪板块轮动。', icon: LayoutDashboard, english: 'MARKET OVERVIEW' },
  { id: 'radar', label: '异动雷达', description: '从短时资金变化中，发现正在启动的板块。', icon: Radar, english: 'MOMENTUM RADAR' },
  { id: 'detail', label: '行业细分', description: '拆解不同订单规模的资金流向。', icon: Layers3, english: 'SECTOR ANALYSIS' },
  { id: 'daily', label: '30日资金', description: '拉长时间，看清板块资金的持续性。', icon: BarChart3, english: 'CAPITAL TRENDS' },
  { id: 'stock', label: '个股研究', description: '搜索股票，追踪日内资金与历史观察记录。', icon: Search, english: 'STOCK RESEARCH' },
] as const

type RadarSector = {
  sector_code: string
  sector_name: string
  main_net: number
  change_15s: number | null
  change_1m: number | null
  change_3m: number | null
  turned_positive: boolean
  turn_time: number | null
  source_time: number
  points: [number, number][]
}

type RadarData = {
  source_time: number | null
  scanned_count: number
  sectors: RadarSector[]
}

type ServiceStatus = {
  market_status: 'preopen' | 'open' | 'lunch' | 'closed' | 'stale' | 'error'
  last_source_time: number | null
  last_received_at: string | null
  selected_count: number
  universe_count?: number
  universe_warning?: string | null
  last_error: string | null
  poll_seconds: number
  backfill_status?: 'idle' | 'running' | 'complete' | 'error'
  backfill_inserted_points?: number
  backfill_error?: string | null
}

type HistoryData = {
  trade_date: string
  selection: Selection[]
  series: SectorSeries[]
  latest: Flow[]
  status: ServiceStatus
}

type SocketMessage =
  | { type: 'snapshot'; data: { selection: Selection[]; flows: Flow[]; radar: RadarData; status: ServiceStatus } }
  | { type: 'update'; data: { source_time: number; received_at: string; complete: boolean; selection: Selection[]; radar: RadarData; flows: Flow[]; status: ServiceStatus } }
  | { type: 'status' | 'heartbeat'; data: ServiceStatus }
  | { type: 'history_backfill'; data: { trade_date: string; inserted_points: number } }

const EMPTY_STATUS: ServiceStatus = {
  market_status: 'closed',
  last_source_time: null,
  last_received_at: null,
  selected_count: 0,
  last_error: null,
  poll_seconds: 3,
}

const FLOW_METRICS = [
  ['main_net', '主力'],
  ['super_large_net', '超大单'],
  ['large_net', '大单'],
  ['mid_net', '中单'],
  ['small_net', '小单'],
] as const

const DETAIL_METRICS = [
  { key: 'main_net', label: '主力', pointIndex: 1, color: '#dc2626' },
  { key: 'super_large_net', label: '超大单', pointIndex: 2, color: '#f97316' },
  { key: 'large_net', label: '大单', pointIndex: 3, color: '#eab308' },
  { key: 'mid_net', label: '中单', pointIndex: 4, color: '#2563eb' },
  { key: 'small_net', label: '小单', pointIndex: 5, color: '#16a34a' },
] as const

const DETAIL_PAGE_SIZE = 6

const MORNING_START_SECONDS = 9 * 3600 + 30 * 60
const MORNING_END_SECONDS = 11 * 3600 + 30 * 60
const AFTERNOON_START_SECONDS = 13 * 3600
const AFTERNOON_END_SECONDS = 15 * 3600
const HALF_DAY_SECONDS = 2 * 3600
const FULL_SESSION_SECONDS = 4 * 3600
const MAIN_LABEL_ANCHOR_SECONDS = FULL_SESSION_SECONDS + 20 * 60

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function formatTime(timestamp?: number | null): string {
  if (!timestamp) return '--:--:--'
  return timeFormatter.format(new Date(timestamp * 1000))
}

function tradingTimeOffset(timestamp: number): number | null {
  // China Standard Time has no daylight-saving transition. Shift to CST and
  // read with UTC getters so the chart behaves identically in every browser.
  const cst = new Date((timestamp + 8 * 3600) * 1000)
  const seconds = cst.getUTCHours() * 3600
    + cst.getUTCMinutes() * 60
    + cst.getUTCSeconds()
  if (seconds >= MORNING_START_SECONDS && seconds <= MORNING_END_SECONDS) {
    return seconds - MORNING_START_SECONDS
  }
  if (seconds >= AFTERNOON_START_SECONDS && seconds <= AFTERNOON_END_SECONDS) {
    return HALF_DAY_SECONDS + seconds - AFTERNOON_START_SECONDS
  }
  return null
}

function tradingAxisLabel(value: number): string {
  const offset = Math.round(value)
  if (offset === HALF_DAY_SECONDS) return '11:30/13:00'
  const seconds = offset < HALF_DAY_SECONDS
    ? MORNING_START_SECONDS + offset
    : AFTERNOON_START_SECONDS + offset - HALF_DAY_SECONDS
  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function spreadEndpointLabels(
  entries: Array<{ key: string; desired: number }>,
  yMin: number,
  yMax: number,
  minimumGapRatio: number,
): Map<string, number> {
  const ordered = [...entries].sort((left, right) => left.desired - right.desired)
  if (ordered.length === 0) return new Map()
  const span = Math.max(yMax - yMin, 1)
  const gap = Math.min(
    span * minimumGapRatio,
    ordered.length <= 1 ? span : span / (ordered.length - 1),
  )
  const positions = ordered.map(({ desired }) => Math.min(yMax, Math.max(yMin, desired)))

  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap)
  }
  if (positions[positions.length - 1] > yMax) {
    const shift = positions[positions.length - 1] - yMax
    for (let index = 0; index < positions.length; index += 1) positions[index] -= shift
  }
  for (let index = positions.length - 2; index >= 0; index -= 1) {
    positions[index] = Math.min(positions[index], positions[index + 1] - gap)
  }
  if (positions[0] < yMin) {
    const shift = yMin - positions[0]
    for (let index = 0; index < positions.length; index += 1) positions[index] += shift
  }

  return new Map(ordered.map((entry, index) => [entry.key, positions[index]]))
}

function chartAmount(value: unknown): number {
  if (Array.isArray(value)) return Number(value[1] ?? 0)
  return Number(value ?? 0)
}

function formatYi(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${(value / 1e8).toFixed(digits)}亿`
}

function RadarSparkline({ points }: { points: [number, number][] }) {
  if (points.length < 2) return <div className="text-xs text-slate-400">正在积累分钟数据…</div>
  const values = points.map((point) => point[1])
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const span = Math.max(1, max - min)
  const first = points[0][0]
  const seconds = Math.max(1, points.at(-1)![0] - first)
  const coordinate = (point: [number, number]) => `${((point[0] - first) / seconds) * 100},${80 - ((point[1] - min) / span) * 70}`
  const zeroY = 80 - ((0 - min) / span) * 70
  return (
    <svg viewBox="0 0 100 90" preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="最近四分钟主力资金累计变化">
      <line x1="0" x2="100" y1={zeroY} y2={zeroY} stroke="var(--app-border)" strokeDasharray="2 2" strokeWidth="0.4" />
      <polyline fill="none" stroke={values.at(-1)! >= 0 ? 'var(--flow-positive)' : 'var(--flow-negative)'} strokeWidth="1.4" vectorEffect="non-scaling-stroke" points={points.map(coordinate).join(' ')} />
    </svg>
  )
}

function formatQuoteDateTime(timestamp: number | null): string {
  if (!timestamp) return '暂无时间'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp * 1000))
}

function displayName(value: string): string {
  return value.replace(/(?:Ⅱ|II|ii)$/u, '')
}

function socketUrl(): string {
  if (process.env.NEXT_PUBLIC_SECTOR_FLOW_WS_URL) {
    return process.env.NEXT_PUBLIC_SECTOR_FLOW_WS_URL
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:8000/ws/sector-flow`
}

function stockSocketUrl(stock: StockSearchResult): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const configured = process.env.NEXT_PUBLIC_SECTOR_FLOW_WS_URL
  const url = configured
    ? new URL(configured)
    : new URL(`${protocol}//${window.location.hostname}:8000/ws/stock-flow`)
  url.pathname = '/ws/stock-flow'
  url.search = ''
  url.searchParams.set('quote_id', stock.quote_id)
  url.searchParams.set('code', stock.code)
  url.searchParams.set('name', stock.name)
  return url.toString()
}

function statusLabel(status: ServiceStatus['market_status']): string {
  return {
    preopen: '盘前',
    open: '交易中',
    lunch: '午休',
    closed: '已休市',
    stale: '数据延迟',
    error: '采集异常',
  }[status]
}

function mergeHistory(
  current: HistoryData,
  flows: Flow[],
  selection?: Selection[],
): HistoryData {
  const nextSelection = selection?.length ? selection : current.selection
  const rankByCode = new Map(nextSelection.map((item) => [item.sector_code, item.rank]))
  const namesByCode = new Map(nextSelection.map((item) => [item.sector_code, item.sector_name]))
  const nextSeries = new Map(
    current.series.map((series) => [
      series.sector_code,
      { ...series, points: [...series.points] },
    ]),
  )
  const nextLatest = new Map(current.latest.map((flow) => [flow.sector_code, flow]))

  for (const flow of flows) {
    const rank = rankByCode.get(flow.sector_code)
    if (!rank) continue
    const series = nextSeries.get(flow.sector_code) ?? {
      rank,
      sector_code: flow.sector_code,
      sector_name: namesByCode.get(flow.sector_code) ?? flow.sector_name,
      points: [],
    }
    series.rank = rank
    series.sector_name = namesByCode.get(flow.sector_code) ?? flow.sector_name
    const lastPoint = series.points.at(-1)
    if (lastPoint?.[0] === flow.source_time) {
      lastPoint[1] = flow.main_net
    } else if (!lastPoint || flow.source_time > lastPoint[0]) {
      series.points.push([flow.source_time, flow.main_net])
    }
    nextSeries.set(flow.sector_code, series)
    nextLatest.set(flow.sector_code, flow)
  }

  return {
    ...current,
    selection: nextSelection,
    series: [...nextSeries.values()].sort((a, b) => a.rank - b.rank),
    latest: [...nextLatest.values()],
  }
}

function detailPointFromFlow(flow: Flow): DetailPoint {
  return [
    flow.source_time,
    flow.main_net,
    flow.super_large_net,
    flow.large_net,
    flow.mid_net,
    flow.small_net,
  ]
}

function mergeDetailHistoryPage(page: DetailHistoryPage, flows: Flow[]): DetailHistoryPage {
  const flowsByCode = new Map(flows.map((flow) => [flow.sector_code, flow]))
  if (!page.series.some((series) => flowsByCode.has(series.sector_code))) return page

  return {
    ...page,
    series: page.series.map((series) => {
      const flow = flowsByCode.get(series.sector_code)
      if (!flow) return series
      const points = [...series.points]
      const nextPoint = detailPointFromFlow(flow)
      const lastPoint = points.at(-1)
      if (lastPoint?.[0] === flow.source_time) {
        points[points.length - 1] = nextPoint
      } else if (!lastPoint || flow.source_time > lastPoint[0]) {
        points.push(nextPoint)
      }
      return { ...series, points }
    }),
  }
}

function MiniSparkline({ points, positive }: { points: [number, number][]; positive: boolean }) {
  if (points.length < 2) return <span className="text-xs text-slate-500">等待数据</span>
  const values = points.map((point) => point[1])
  const low = Math.min(...values)
  const range = Math.max(1, Math.max(...values) - low)
  const path = values.map((value, index) => `${index / (values.length - 1) * 180},${44 - (value - low) / range * 38}`).join(' ')
  return <svg className="mini-sparkline" viewBox="0 0 180 50" role="img" aria-label="当日资金走势"><polyline points={path} fill="none" stroke={positive ? 'var(--flow-positive)' : 'var(--flow-negative)'} strokeWidth="1.8" strokeLinejoin="round" /></svg>
}

function DetailSectorChart({
  sector,
  flashing,
}: {
  sector: DetailSectorSeries
  flashing: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)

  const theme = useContext(ThemeContext)
  const palette = CHART_THEMES[theme]
  const option = useMemo<EChartsOption>(() => {
    const chartSeries: Array<LineSeriesOption | ScatterSeriesOption | EffectScatterSeriesOption> = []
    const preparedMetrics = DETAIL_METRICS.map((metric) => {
      const values = sector.points.flatMap((point) => {
        const offset = tradingTimeOffset(point[0])
        return offset === null ? [] : [[offset, point[metric.pointIndex] / 1e8, point[0]]]
      })
      const endpoint = values.at(-1)
      return { metric, values, endpoint, latest: Number(endpoint?.[1] ?? 0) }
    })
    const plottedAmounts = preparedMetrics.flatMap(({ values }) => (
      values.map((value) => Number(value[1]))
    ))
    const dataMin = Math.min(0, ...plottedAmounts)
    const dataMax = Math.max(0, ...plottedAmounts)
    const dataSpan = Math.max(dataMax - dataMin, Math.abs(dataMax) * 0.2, Math.abs(dataMin) * 0.2, 1)
    const yMin = dataMin - dataSpan * 0.16
    const yMax = dataMax + dataSpan * 0.16
    const labelYByKey = spreadEndpointLabels(
      preparedMetrics
        .filter(({ endpoint }) => endpoint)
        .map(({ metric, latest }) => ({ key: metric.key, desired: latest })),
      yMin,
      yMax,
      0.085,
    )

    preparedMetrics.forEach(({ metric, values, endpoint, latest }, metricIndex) => {
      chartSeries.push({
        id: `${sector.sector_code}-${metric.key}`,
        name: metric.label,
        type: 'line',
        data: values,
        encode: { x: 0, y: 1 },
        showSymbol: false,
        sampling: 'lttb',
        animationDurationUpdate: 300,
        lineStyle: { width: metric.key === 'main_net' ? 2.2 : 1.5, color: metric.color, opacity: 0.9 },
        itemStyle: { color: metric.color },
        emphasis: { focus: 'series', lineStyle: { width: 3 } },
        markLine: metricIndex === 0 ? {
          symbol: 'none',
          silent: true,
          lineStyle: { color: palette.muted, width: 1, opacity: 0.65 },
          label: { show: false },
          data: [{ yAxis: 0 }],
        } : undefined,
      })

      if (!endpoint) return
      const labelY = labelYByKey.get(metric.key) ?? latest
      chartSeries.push({
        id: `${sector.sector_code}-${metric.key}-endpoint-label`,
        name: `${metric.label} endpoint label`,
        type: 'scatter',
        data: [[endpoint[0], labelY, endpoint[2]]],
        encode: { x: 0, y: 1 },
        symbol: 'circle',
        symbolSize: 1,
        clip: false,
        silent: true,
        tooltip: { show: false },
        z: 5,
        itemStyle: { opacity: 0 },
        label: {
          show: true,
          opacity: 1,
          position: 'right',
          distance: 5,
          verticalAlign: 'middle',
          color: metric.color,
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 14,
          formatter: () => `${latest >= 0 ? '+' : ''}${latest.toFixed(2)}亿`,
        },
        labelLayout: { hideOverlap: false },
      })
      chartSeries.push({
        id: `${sector.sector_code}-${metric.key}-endpoint`,
        name: `${metric.label} endpoint`,
        type: 'scatter',
        data: [endpoint],
        encode: { x: 0, y: 1 },
        symbol: 'circle',
        symbolSize: 6,
        silent: true,
        tooltip: { show: false },
        z: 4,
        itemStyle: { color: metric.color, opacity: 0.65, borderWidth: 0 },
      })
      if (flashing) {
        chartSeries.push({
          id: `${sector.sector_code}-${metric.key}-endpoint-flash`,
          name: `${metric.label} update`,
          type: 'effectScatter',
          data: [endpoint],
          encode: { x: 0, y: 1 },
          symbol: 'circle',
          symbolSize: 6,
          silent: true,
          tooltip: { show: false },
          z: 5,
          itemStyle: { color: metric.color, opacity: 0.25 },
          rippleEffect: { period: 1.2, scale: 1.8, brushType: 'stroke' },
        })
      }
    })

    return {
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 300,
      grid: { left: 44, right: 84, top: 22, bottom: 36, containLabel: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        renderMode: 'richText',
        backgroundColor: palette.surface,
        borderColor: palette.axis,
        textStyle: { color: palette.text, fontSize: 12 },
        formatter: (params: unknown) => {
          const items = (Array.isArray(params) ? params : [params]) as Array<{
            seriesName?: string
            value?: unknown
          }>
          const firstValue = items[0]?.value
          const sourceTime = Array.isArray(firstValue) ? Number(firstValue[2] ?? 0) : 0
          return [
            sourceTime ? formatTime(sourceTime) : '--:--:--',
            ...items.map((item) => {
              const amount = chartAmount(item.value)
              return `${item.seriesName ?? ''}  ${amount >= 0 ? '+' : ''}${amount.toFixed(2)}亿元`
            }),
          ].join('\n')
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: FULL_SESSION_SECONDS,
        interval: 2 * 3600,
        axisLabel: {
          color: palette.muted,
          fontSize: 10,
          hideOverlap: true,
          formatter: (value: number) => tradingAxisLabel(value),
        },
        axisLine: { lineStyle: { color: palette.axis } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: yMin,
        max: yMax,
        name: '净流入（亿元）',
        nameLocation: 'middle',
        nameRotate: 90,
        nameGap: 38,
        nameTextStyle: { color: palette.muted, fontSize: 10 },
        axisLabel: { color: palette.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: palette.grid, opacity: 0.45 } },
      },
      series: chartSeries,
    }
  }, [flashing, sector, palette])

  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | null = null
    void import('echarts').then((echarts) => {
      if (disposed || !containerRef.current) return
      chartRef.current = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
      observer = new ResizeObserver(() => chartRef.current?.resize())
      observer.observe(containerRef.current)
    })
    return () => {
      disposed = true
      observer?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  return (
    <article className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <h3 className="truncate text-sm font-medium">{displayName(sector.sector_name)}</h3>
        <span className="font-mono text-[11px] text-slate-400">{sector.sector_code}</span>
      </div>
      <div ref={containerRef} className="h-[250px] w-full xl:min-h-0 xl:flex-1" aria-label={`${displayName(sector.sector_name)}细分资金流向曲线`} />
    </article>
  )
}

function StockFlowChart({
  data,
  flashing,
}: {
  data: StockFlowHistory
  flashing: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)

  const theme = useContext(ThemeContext)
  const palette = CHART_THEMES[theme]
  const option = useMemo<EChartsOption>(() => {
    const chartSeries: Array<LineSeriesOption | ScatterSeriesOption | EffectScatterSeriesOption> = []
    const preparedMetrics = DETAIL_METRICS.map((metric) => {
      const values = data.points.flatMap((point) => {
        const offset = tradingTimeOffset(point[0])
        return offset === null ? [] : [[offset, point[metric.pointIndex] / 1e8, point[0]]]
      })
      const endpoint = values.at(-1)
      return { metric, values, endpoint, latest: Number(endpoint?.[1] ?? 0) }
    })
    const plottedAmounts = preparedMetrics.flatMap(({ values }) => (
      values.map((value) => Number(value[1]))
    ))
    const dataMin = Math.min(0, ...plottedAmounts)
    const dataMax = Math.max(0, ...plottedAmounts)
    const dataSpan = Math.max(dataMax - dataMin, Math.abs(dataMax) * 0.2, Math.abs(dataMin) * 0.2, 1)
    const yMin = dataMin - dataSpan * 0.12
    const yMax = dataMax + dataSpan * 0.12
    const labelYByKey = spreadEndpointLabels(
      preparedMetrics
        .filter(({ endpoint }) => endpoint)
        .map(({ metric, latest }) => ({ key: metric.key, desired: latest })),
      yMin,
      yMax,
      0.04,
    )

    preparedMetrics.forEach(({ metric, values, endpoint, latest }, metricIndex) => {
      chartSeries.push({
        id: `stock-${data.stock.quote_id}-${metric.key}`,
        name: metric.label,
        type: 'line',
        data: values,
        encode: { x: 0, y: 1 },
        showSymbol: false,
        sampling: 'lttb',
        animationDurationUpdate: 300,
        lineStyle: {
          width: metric.key === 'main_net' ? 2.4 : 1.7,
          color: metric.color,
          opacity: 0.92,
        },
        itemStyle: { color: metric.color },
        emphasis: { focus: 'series', lineStyle: { width: 3.2 } },
        markLine: metricIndex === 0 ? {
          symbol: 'none',
          silent: true,
          lineStyle: { color: palette.muted, width: 1, opacity: 0.65 },
          label: { show: false },
          data: [{ yAxis: 0 }],
        } : undefined,
      })

      if (!endpoint) return
      const labelY = labelYByKey.get(metric.key) ?? latest
      chartSeries.push({
        id: `stock-${data.stock.quote_id}-${metric.key}-endpoint-label`,
        name: `${metric.label} endpoint label`,
        type: 'scatter',
        data: [[endpoint[0], labelY, endpoint[2]]],
        encode: { x: 0, y: 1 },
        symbol: 'circle',
        symbolSize: 1,
        clip: false,
        silent: true,
        tooltip: { show: false },
        z: 5,
        itemStyle: { opacity: 0 },
        label: {
          show: true,
          opacity: 1,
          position: 'right',
          distance: 6,
          verticalAlign: 'middle',
          color: metric.color,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 16,
          formatter: () => `${latest >= 0 ? '+' : ''}${latest.toFixed(2)}亿`,
        },
        labelLayout: { hideOverlap: false },
      })
      chartSeries.push({
        id: `stock-${data.stock.quote_id}-${metric.key}-endpoint`,
        name: `${metric.label} endpoint`,
        type: 'scatter',
        data: [endpoint],
        encode: { x: 0, y: 1 },
        symbol: 'circle',
        symbolSize: 6,
        silent: true,
        tooltip: { show: false },
        z: 4,
        itemStyle: { color: metric.color, opacity: 0.65, borderWidth: 0 },
      })
      if (flashing) {
        chartSeries.push({
          id: `stock-${data.stock.quote_id}-${metric.key}-flash`,
          name: `${metric.label} update`,
          type: 'effectScatter',
          data: [endpoint],
          encode: { x: 0, y: 1 },
          symbol: 'circle',
          symbolSize: 6,
          silent: true,
          tooltip: { show: false },
          z: 5,
          itemStyle: { color: metric.color, opacity: 0.25 },
          rippleEffect: { period: 1.2, scale: 1.8, brushType: 'stroke' },
        })
      }
    })

    return {
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 300,
      grid: { left: 60, right: 104, top: 28, bottom: 42, containLabel: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        renderMode: 'richText',
        backgroundColor: palette.surface,
        borderColor: palette.axis,
        textStyle: { color: palette.text, fontSize: 12 },
        formatter: (params: unknown) => {
          const items = (Array.isArray(params) ? params : [params]) as Array<{
            seriesName?: string
            value?: unknown
          }>
          const firstValue = items[0]?.value
          const sourceTime = Array.isArray(firstValue) ? Number(firstValue[2] ?? 0) : 0
          return [
            sourceTime ? formatTime(sourceTime) : '--:--:--',
            ...items.map((item) => {
              const amount = chartAmount(item.value)
              return `${item.seriesName ?? ''}  ${amount >= 0 ? '+' : ''}${amount.toFixed(2)}亿元`
            }),
          ].join('\n')
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: FULL_SESSION_SECONDS,
        interval: 30 * 60,
        axisLabel: {
          color: palette.muted,
          hideOverlap: true,
          showMinLabel: true,
          showMaxLabel: true,
          formatter: (value: number) => tradingAxisLabel(value),
        },
        axisLine: { lineStyle: { color: palette.axis } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: yMin,
        max: yMax,
        name: '累计净流入（亿元）',
        nameLocation: 'middle',
        nameRotate: 90,
        nameGap: 48,
        nameTextStyle: { color: palette.muted },
        axisLabel: { color: palette.muted, formatter: (value: number) => value.toFixed(1) },
        splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      },
      series: chartSeries,
    }
  }, [data, flashing, palette])

  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | null = null
    void import('echarts').then((echarts) => {
      if (disposed || !containerRef.current) return
      chartRef.current = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
      observer = new ResizeObserver(() => chartRef.current?.resize())
      observer.observe(containerRef.current)
    })
    return () => {
      disposed = true
      observer?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  return <div ref={containerRef} className="absolute inset-0" aria-label={`${data.stock.name}秒级实时资金流向曲线`} />
}

function DailySectorChart({ sector }: { sector: DailySectorSeries }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)

  const theme = useContext(ThemeContext)
  const palette = CHART_THEMES[theme]
  const option = useMemo<EChartsOption>(() => {
    const values = sector.points.map((point) => [point[0], point[1] / 1e8])
    const lastDateIndex = values.length - 1
    const dateLabelStep = Math.max(1, Math.ceil(values.length / 6))
    const barSeries: BarSeriesOption = {
      id: `daily-${sector.sector_code}-main`,
      name: '主力',
      type: 'bar',
      data: values,
      encode: { x: 0, y: 1 },
      barMaxWidth: 14,
      barMinHeight: 1,
      animationDurationUpdate: 300,
      itemStyle: {
        color: (params) => {
          const amount = chartAmount(params.value)
          return amount > 0 ? palette.positive : amount < 0 ? palette.negative : palette.muted
        },
      },
      emphasis: { focus: 'series' },
      markLine: {
        symbol: 'none',
        silent: true,
        lineStyle: { color: palette.muted, width: 1, opacity: 0.75 },
        label: { show: false },
        data: [{ yAxis: 0 }],
      },
    }

    return {
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 300,
      grid: { left: 44, right: 18, top: 18, bottom: 36, containLabel: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        renderMode: 'richText',
        backgroundColor: palette.surface,
        borderColor: palette.axis,
        textStyle: { color: palette.text, fontSize: 12 },
        formatter: (params: unknown) => {
          const items = (Array.isArray(params) ? params : [params]) as Array<{
            seriesName?: string
            value?: unknown
          }>
          const firstValue = items[0]?.value
          const tradeDate = Array.isArray(firstValue) ? String(firstValue[0] ?? '') : ''
          return [
            tradeDate || '--',
            ...items.map((item) => {
              const amount = chartAmount(item.value)
              return `${item.seriesName ?? ''}  ${amount >= 0 ? '+' : ''}${amount.toFixed(2)}亿元`
            }),
          ].join('\n')
        },
      },
      xAxis: {
        type: 'category',
        boundaryGap: true,
        axisLabel: {
          color: palette.muted,
          hideOverlap: false,
          showMinLabel: true,
          showMaxLabel: true,
          interval: (index: number) => (
            index === 0
            || index === lastDateIndex
            || index % dateLabelStep === 0
          ),
          formatter: (value: string) => value.slice(5),
        },
        axisLine: { lineStyle: { color: palette.axis } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '主力净流入（亿元）',
        nameLocation: 'middle',
        nameRotate: 90,
        nameGap: 38,
        nameTextStyle: { color: palette.muted, fontSize: 10 },
        axisLabel: { color: palette.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: palette.grid, opacity: 0.45 } },
      },
      series: [barSeries],
    }
  }, [sector, palette])

  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | null = null
    void import('echarts').then((echarts) => {
      if (disposed || !containerRef.current) return
      chartRef.current = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
      observer = new ResizeObserver(() => chartRef.current?.resize())
      observer.observe(containerRef.current)
    })
    return () => {
      disposed = true
      observer?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  return (
    <article className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <h3 className="truncate text-sm font-medium">{displayName(sector.sector_name)}</h3>
        <span className="font-mono text-[11px] text-slate-400">{sector.sector_code}</span>
      </div>
      <div ref={containerRef} className="h-[250px] w-full xl:min-h-0 xl:flex-1" aria-label={`${displayName(sector.sector_name)}最近30日主力资金柱状图`} />
    </article>
  )
}

export default function SectorFlowPage() {
  const chartContainer = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)
  const chartOptionRef = useRef<EChartsOption>({})
  const visibleCodesRef = useRef<Set<string>>(new Set())
  const hoveredCodeRef = useRef<string | null>(null)
  const pinnedCodeRef = useRef<string | null>(null)
  const highlightedCodeRef = useRef<string | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const stockSocketRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stockReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endpointFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stockFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempts = useRef(0)
  const latestFlowsRef = useRef<Flow[]>([])
  const [history, setHistory] = useState<HistoryData>({
    trade_date: '',
    selection: [],
    series: [],
    latest: [],
    status: EMPTY_STATUS,
  })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [flashingEndpoints, setFlashingEndpoints] = useState<Set<string>>(() => new Set())
  const [chartMode, setChartMode] = useState<ChartMode>('main')
  const [theme, setTheme] = useState<Theme>('dark')
  const palette = CHART_THEMES[theme]
  const navigateView = useCallback((mode: ChartMode) => {
    setChartMode(mode)
    window.history.pushState(null, '', `#${mode}`)
  }, [])
  const changeTheme = (nextTheme: Theme) => {
    setTheme(nextTheme)
    document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    document.documentElement.style.colorScheme = nextTheme
    try { window.localStorage.setItem('capitalpulse.theme', nextTheme) } catch { /* Theme still works without storage. */ }
  }

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    const syncView = () => {
      const view = window.location.hash.slice(1)
      setChartMode(WORKSPACE_VIEWS.find((item) => item.id === view)?.id ?? 'main')
    }
    syncView()
    window.addEventListener('popstate', syncView)
    window.addEventListener('hashchange', syncView)
    return () => {
      window.removeEventListener('popstate', syncView)
      window.removeEventListener('hashchange', syncView)
    }
  }, [])
  const [radar, setRadar] = useState<RadarData>({ source_time: null, scanned_count: 0, sectors: [] })
  const [radarFocusedCode, setRadarFocusedCode] = useState<string | null>(null)
  const selectionCodesRef = useRef<string>('')
  const [hoveredCode, setHoveredCode] = useState<string | null>(null)
  const [pinnedCode, setPinnedCode] = useState<string | null>(null)
  const [candidateData, setCandidateData] = useState<SectorCandidateData | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [candidateError, setCandidateError] = useState<string | null>(null)
  const [candidateRefresh, setCandidateRefresh] = useState(0)
  const [detailPage, setDetailPage] = useState(1)
  const [detailPages, setDetailPages] = useState<Record<number, DetailHistoryPage>>({})
  const [detailLoadingPage, setDetailLoadingPage] = useState<number | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [dailyPage, setDailyPage] = useState(1)
  const [dailyPages, setDailyPages] = useState<Record<number, DailyHistoryData>>({})
  const [dailyLoadingPage, setDailyLoadingPage] = useState<number | null>(null)
  const [dailyError, setDailyError] = useState<string | null>(null)
  const [stockQuery, setStockQuery] = useState('')
  const [stockSearchResults, setStockSearchResults] = useState<StockSearchResult[]>([])
  const [stockSearching, setStockSearching] = useState(false)
  const [stockSearchError, setStockSearchError] = useState<string | null>(null)
  const [selectedStock, setSelectedStock] = useState<StockSearchResult | null>(null)
  const [recentStocks, setRecentStocks] = useState<StockSearchResult[]>([])
  const [recentStocksReady, setRecentStocksReady] = useState(false)
  const [stockRuntimeId, setStockRuntimeId] = useState<string | null>(null)
  const [stockSelectionReady, setStockSelectionReady] = useState(false)
  const [stockHistory, setStockHistory] = useState<StockFlowHistory | null>(null)
  const [stockMarketStatus, setStockMarketStatus] = useState<ServiceStatus['market_status']>('closed')
  const [stockError, setStockError] = useState<string | null>(null)
  const [stockFlashing, setStockFlashing] = useState(false)

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STOCK_RECENTS_STORAGE_KEY)
      if (saved) setRecentStocks(parseRecentStocks(JSON.parse(saved)))
    } catch {
      // Browsers with unavailable storage still keep recent stocks for this visit.
    }
    setRecentStocksReady(true)
  }, [])

  useEffect(() => {
    if (!recentStocksReady || !stockSelectionReady || !selectedStock) return
    setRecentStocks((recent) => rememberStock(recent, selectedStock))
  }, [recentStocksReady, selectedStock, stockSelectionReady])

  useEffect(() => {
    if (!recentStocksReady) return
    try {
      window.localStorage.setItem(STOCK_RECENTS_STORAGE_KEY, JSON.stringify(recentStocks))
    } catch {
      // Recent stocks remain available in memory when browser storage is disabled.
    }
  }, [recentStocks, recentStocksReady])

  useEffect(() => {
    const controller = new AbortController()

    const restoreStockSelection = async () => {
      try {
        const response = await fetch('/api/finance/stock-flow/session', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json()
        if (!response.ok || payload.code !== 200 || !payload.data) {
          throw new Error(payload.msg || '个股运行状态加载失败')
        }
        const session = payload.data as StockFlowSession
        let restoredStock = session.default_stock?.quote_id
          ? session.default_stock
          : DEFAULT_STOCK
        try {
          const cachedText = window.localStorage.getItem(STOCK_SELECTION_STORAGE_KEY)
          const cached = cachedText
            ? JSON.parse(cachedText) as { runtime_id?: string; stock?: StockSearchResult }
            : null
          if (
            cached?.runtime_id === session.runtime_id
            && cached.stock?.quote_id
            && cached.stock.code
            && cached.stock.name
          ) {
            restoredStock = cached.stock
          }
        } catch {
          // A malformed or unavailable browser cache falls back to the default stock.
        }
        if (!controller.signal.aborted) {
          setStockRuntimeId(session.runtime_id)
          setSelectedStock(restoredStock)
        }
      } catch {
        if (!controller.signal.aborted) setSelectedStock(DEFAULT_STOCK)
      } finally {
        if (!controller.signal.aborted) setStockSelectionReady(true)
      }
    }

    void restoreStockSelection()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!stockSelectionReady || !stockRuntimeId || !selectedStock) return
    try {
      window.localStorage.setItem(STOCK_SELECTION_STORAGE_KEY, JSON.stringify({
        runtime_id: stockRuntimeId,
        stock: selectedStock,
      }))
    } catch {
      // Browsers with disabled storage still keep the in-memory selection.
    }
  }, [selectedStock, stockRuntimeId, stockSelectionReady])

  const fetchHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/finance/sector-flow/history?top=30', {
        cache: 'no-store',
      })
      const payload = await response.json()
      if (!response.ok || payload.code !== 200 || !payload.data) {
        throw new Error(payload.msg || '历史数据加载失败')
      }
      setHistory(payload.data as HistoryData)
      latestFlowsRef.current = (payload.data as HistoryData).latest
      setDetailPages({})
      setDetailError(null)
      setDailyPages({})
      setDailyError(null)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '历史数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const flashUpdatedEndpoints = useCallback((flows: Flow[]) => {
    setFlashingEndpoints(new Set(flows.map((flow) => flow.sector_code)))
    if (endpointFlashTimer.current) clearTimeout(endpointFlashTimer.current)
    endpointFlashTimer.current = setTimeout(() => {
      setFlashingEndpoints(new Set())
      endpointFlashTimer.current = null
    }, 1200)
  }, [])

  const connectSocket = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return
    const socket = new WebSocket(socketUrl())
    socketRef.current = socket

    socket.onopen = () => {
      reconnectAttempts.current = 0
      void fetchHistory()
    }
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as SocketMessage
        if (message.type === 'snapshot') {
          if (message.data.radar) setRadar(message.data.radar)
          setDetailPages((pages) => Object.fromEntries(
            Object.entries(pages).map(([page, data]) => [page, mergeDetailHistoryPage(data, message.data.flows)]),
          ))
          setHistory((current) => ({
            ...mergeHistory(current, message.data.flows, message.data.selection),
            status: message.data.status,
          }))
        } else if (message.type === 'update') {
          if (message.data.radar) setRadar(message.data.radar)
          flashUpdatedEndpoints(message.data.flows)
          setDetailPages((pages) => Object.fromEntries(
            Object.entries(pages).map(([page, data]) => [page, mergeDetailHistoryPage(data, message.data.flows)]),
          ))
          setHistory((current) => ({
            ...mergeHistory(current, message.data.flows, message.data.selection),
            status: message.data.status,
          }))
        } else if (message.type === 'history_backfill') {
          void fetchHistory()
        } else if (message.type === 'status' || message.type === 'heartbeat') {
          setHistory((current) => ({ ...current, status: message.data }))
        }
      } catch {
        // Ignore malformed upstream messages; the next valid snapshot recovers state.
      }
    }
    socket.onclose = () => {
      socketRef.current = null
      const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 15000)
      reconnectAttempts.current += 1
      reconnectTimer.current = setTimeout(connectSocket, delay)
    }
    socket.onerror = () => socket.close()
  }, [fetchHistory, flashUpdatedEndpoints])

  useEffect(() => {
    void fetchHistory()
    connectSocket()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (endpointFlashTimer.current) clearTimeout(endpointFlashTimer.current)
      const socket = socketRef.current
      socketRef.current = null
      if (socket) {
        socket.onclose = null
        socket.close()
      }
    }
  }, [connectSocket, fetchHistory])

  useEffect(() => {
    latestFlowsRef.current = history.latest
  }, [history.latest])

  useEffect(() => {
    const codes = history.selection.map((sector) => sector.sector_code).sort().join(',')
    if (codes && selectionCodesRef.current && codes !== selectionCodesRef.current) {
      void fetchHistory()
    }
    selectionCodesRef.current = codes
  }, [history.selection, fetchHistory])

  useEffect(() => {
    if (chartMode !== 'detail' || detailPages[detailPage]) return
    const controller = new AbortController()
    const requestedPage = detailPage
    setDetailLoadingPage(requestedPage)
    setDetailError(null)

    void fetch(`/api/finance/sector-flow/detail-history?page=${requestedPage}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok || payload.code !== 200 || !payload.data) {
          throw new Error(payload.msg || '行业细分历史加载失败')
        }
        const data = mergeDetailHistoryPage(
          payload.data as DetailHistoryPage,
          latestFlowsRef.current,
        )
        setDetailPages((pages) => ({ ...pages, [requestedPage]: data }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setDetailError(error instanceof Error ? error.message : '行业细分历史加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoadingPage((page) => page === requestedPage ? null : page)
        }
      })

    return () => controller.abort()
  }, [chartMode, detailPage, detailPages])

  useEffect(() => {
    if (chartMode !== 'daily' || dailyPages[dailyPage]) return
    const controller = new AbortController()
    const requestedPage = dailyPage
    setDailyLoadingPage(requestedPage)
    setDailyError(null)

    void fetch(
      `/api/finance/sector-flow/daily-history?top=30&days=30&page=${requestedPage}`,
      { cache: 'no-store', signal: controller.signal },
    )
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok || payload.code !== 200 || !payload.data) {
          throw new Error(payload.msg || '30日日频资金数据加载失败')
        }
        const data = payload.data as DailyHistoryData
        setDailyPages((pages) => ({
          ...pages,
          [requestedPage]: mergeDailyHistory(pages[requestedPage] ?? null, data),
        }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setDailyError(error instanceof Error ? error.message : '30日日频资金数据加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDailyLoadingPage((page) => page === requestedPage ? null : page)
        }
      })

    return () => controller.abort()
  }, [chartMode, dailyPage, dailyPages])

  useEffect(() => {
    if (chartMode !== 'stock') return
    const keyword = stockQuery.trim()
    if (!keyword) {
      setStockSearchResults([])
      setStockSearchError(null)
      setStockSearching(false)
      return
    }
    const controller = new AbortController()
    setStockSearching(true)
    setStockSearchError(null)
    const timer = setTimeout(() => {
      void fetch(`/api/finance/stock-flow/search?q=${encodeURIComponent(keyword)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json()
          if (!response.ok || payload.code !== 200 || !Array.isArray(payload.data)) {
            throw new Error(payload.msg || '股票搜索失败')
          }
          setStockSearchResults(payload.data as StockSearchResult[])
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setStockSearchError(error instanceof Error ? error.message : '股票搜索失败')
          setStockSearchResults([])
        })
        .finally(() => {
          if (!controller.signal.aborted) setStockSearching(false)
        })
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [chartMode, stockQuery])

  useEffect(() => {
    if (chartMode !== 'stock' || !selectedStock) return
    let disposed = false
    let reconnectAttempts = 0

    const flashStockEndpoints = () => {
      setStockFlashing(true)
      if (stockFlashTimer.current) clearTimeout(stockFlashTimer.current)
      stockFlashTimer.current = setTimeout(() => {
        setStockFlashing(false)
        stockFlashTimer.current = null
      }, 1200)
    }

    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(stockSocketUrl(selectedStock))
      stockSocketRef.current = socket
      socket.onopen = () => {
        reconnectAttempts = 0
        setStockError(null)
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as StockSocketMessage
          if (message.type === 'snapshot') {
            if (
              stockRuntimeId
              && message.data.runtime_id
              && message.data.runtime_id !== stockRuntimeId
            ) {
              setStockRuntimeId(message.data.runtime_id)
              setSelectedStock(DEFAULT_STOCK)
              setStockHistory(null)
              return
            }
            if (!stockRuntimeId && message.data.runtime_id) {
              setStockRuntimeId(message.data.runtime_id)
            }
            setStockHistory(message.data)
            setStockMarketStatus(message.data.market_status)
          } else if (message.type === 'update') {
            const point: DetailPoint = [
              message.data.source_time,
              message.data.main_net,
              message.data.super_large_net,
              message.data.large_net,
              message.data.mid_net,
              message.data.small_net,
            ]
            setStockHistory((current) => {
              const next = current ?? {
                runtime_id: stockRuntimeId ?? '',
                trade_date: new Date().toISOString().slice(0, 10),
                stock: {
                  quote_id: selectedStock.quote_id,
                  code: selectedStock.code,
                  name: selectedStock.name,
                },
                points: [],
                poll_seconds: 3,
                market_status: 'open' as const,
              }
              const points = [...next.points]
              const lastPoint = points.at(-1)
              if (lastPoint?.[0] === point[0]) {
                points[points.length - 1] = point
              } else if (!lastPoint || point[0] > lastPoint[0]) {
                points.push(point)
              }
              return { ...next, points, market_status: 'open' }
            })
            setStockMarketStatus('open')
            flashStockEndpoints()
          } else {
            setStockMarketStatus(message.data.market_status)
          }
        } catch {
          // A later valid snapshot or update recovers malformed messages.
        }
      }
      socket.onclose = () => {
        if (stockSocketRef.current === socket) stockSocketRef.current = null
        if (disposed) return
        setStockError('个股实时连接已断开，正在重连…')
        const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000)
        reconnectAttempts += 1
        stockReconnectTimer.current = setTimeout(connect, delay)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      disposed = true
      if (stockReconnectTimer.current) clearTimeout(stockReconnectTimer.current)
      if (stockFlashTimer.current) clearTimeout(stockFlashTimer.current)
      stockReconnectTimer.current = null
      stockFlashTimer.current = null
      const socket = stockSocketRef.current
      stockSocketRef.current = null
      if (socket) {
        socket.onclose = null
        socket.close()
      }
      setStockFlashing(false)
    }
  }, [chartMode, selectedStock, stockRuntimeId])

  const highlightSector = useCallback((code: string | null) => {
    const chart = chartRef.current
    if (!chart || highlightedCodeRef.current === code) return
    if (highlightedCodeRef.current) {
      chart.dispatchAction({ type: 'downplay', seriesId: highlightedCodeRef.current })
    }
    if (code) chart.dispatchAction({ type: 'highlight', seriesId: code })
    highlightedCodeRef.current = code
  }, [])

  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | null = null
    void import('echarts').then((echarts) => {
      if (disposed || !chartContainer.current) return
      const chart = echarts.init(chartContainer.current, undefined, { renderer: 'canvas' })
      chartRef.current = chart
      chart.setOption(chartOptionRef.current, { notMerge: true, lazyUpdate: true })
      observer = new ResizeObserver(() => chart.resize())
      observer.observe(chartContainer.current)

      const eventCode = (params: { seriesId?: string; seriesIndex?: number }) => {
        const optionSeries = chartOptionRef.current.series
        const seriesId = typeof params.seriesIndex === 'number' && Array.isArray(optionSeries)
          ? optionSeries[params.seriesIndex]?.id
          : params.seriesId
        const code = seriesId == null ? null : String(seriesId).replace(/-label-connector$/, '')
        return code && visibleCodesRef.current.has(code) ? code : null
      }
      const clearHover = () => {
        if (!hoveredCodeRef.current) return
        hoveredCodeRef.current = null
        setHoveredCode(null)
        highlightSector(pinnedCodeRef.current)
      }
      chart.on('mouseover', (params) => {
        const code = eventCode(params)
        if (!code || hoveredCodeRef.current === code) return
        hoveredCodeRef.current = code
        setHoveredCode(code)
        highlightSector(code)
      })
      chart.on('mouseout', clearHover)
      chart.getZr().on('globalout', clearHover)
      chart.on('click', (params) => {
        const code = eventCode(params)
        if (!code) return
        const next = pinnedCodeRef.current === code ? null : code
        pinnedCodeRef.current = next
        setPinnedCode(next)
        highlightSector(hoveredCodeRef.current ?? next)
      })
    })
    const resize = () => chartRef.current?.resize()
    window.addEventListener('resize', resize)
    return () => {
      disposed = true
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      chartRef.current?.dispose()
      chartRef.current = null
      highlightedCodeRef.current = null
    }
  }, [highlightSector])

  const visibleSelection = history.selection
  const visibleCodes = useMemo(
    () => new Set(visibleSelection.map((item) => item.sector_code)),
    [visibleSelection],
  )
  useEffect(() => {
    visibleCodesRef.current = visibleCodes
    if (pinnedCodeRef.current && !visibleCodes.has(pinnedCodeRef.current)) {
      pinnedCodeRef.current = null
      setPinnedCode(null)
      highlightSector(hoveredCodeRef.current)
    }
  }, [highlightSector, visibleCodes])
  useEffect(() => {
    if (chartMode !== 'main' || !pinnedCode) return
    const controller = new AbortController()
    const sectorCode = pinnedCode
    setCandidateData(null)
    setCandidateError(null)
    setCandidateLoading(true)
    void fetch(`/api/finance/sector-flow/candidates?sector_code=${encodeURIComponent(sectorCode)}&limit=5`, {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('请求失败')
      const payload = await response.json() as { code: number; data: SectorCandidateData | null }
      if (payload.code !== 200 || !payload.data) throw new Error('行情暂不可用')
      setCandidateData(payload.data)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setCandidateError(error instanceof Error ? error.message : '请求失败')
      }
    }).finally(() => {
      if (!controller.signal.aborted) setCandidateLoading(false)
    })
    return () => controller.abort()
  }, [chartMode, pinnedCode, candidateRefresh])
  const visibleLatest = useMemo(
    () => history.latest.filter((item) => visibleCodes.has(item.sector_code)),
    [history.latest, visibleCodes],
  )
  const latestByCode = useMemo(
    () => new Map(visibleLatest.map((item) => [item.sector_code, item])),
    [visibleLatest],
  )
  const focusedCode = hoveredCode ?? pinnedCode
  const focusedSector = focusedCode
    ? history.series.find((item) => item.sector_code === focusedCode)
    : null
  const pinnedSector = pinnedCode
    ? history.series.find((item) => item.sector_code === pinnedCode)
    : null
  const focusedLatest = focusedSector
    ? latestByCode.get(focusedSector.sector_code)?.main_net ?? focusedSector.points.at(-1)?.[1] ?? 0
    : 0

  const chartOption = useMemo<EChartsOption>(() => {
    const visibleSeries = history.series.filter((item) => visibleCodes.has(item.sector_code))
    const series: Array<LineSeriesOption | ScatterSeriesOption | EffectScatterSeriesOption> = []
    const prepared = visibleSeries.map((item) => {
      const values = item.points.flatMap(([timestamp, value]) => {
        const offset = tradingTimeOffset(timestamp)
        return offset === null ? [] : [[offset, value / 1e8, timestamp]]
      })
      const latest = latestByCode.get(item.sector_code)?.main_net ?? item.points.at(-1)?.[1] ?? 0
      return { item, values, latest, endpoint: values.at(-1) }
    })
    const plottedAmounts = prepared.flatMap(({ values }) => (
      values.map((value) => Number(value[1]))
    ))
    const dataMin = Math.min(0, ...plottedAmounts)
    const dataMax = Math.max(0, ...plottedAmounts)
    const dataSpan = Math.max(
      dataMax - dataMin,
      Math.abs(dataMax) * 0.15,
      Math.abs(dataMin) * 0.15,
      1,
    )
    const yMin = dataMin - dataSpan * 0.08
    const yMax = dataMax + dataSpan * 0.08
    const labelSpan = yMax - yMin
    const orderedLabels = prepared
      .filter((entry) => entry.endpoint)
      .sort((a, b) => b.latest - a.latest || a.item.rank - b.item.rank)
    const labelYByCode = new Map(orderedLabels.map((entry, index) => [
      entry.item.sector_code,
      orderedLabels.length <= 1
        ? (yMin + yMax) / 2
        : yMax - labelSpan * (0.025 + (index / (orderedLabels.length - 1)) * 0.95),
    ]))

    prepared.forEach(({ item, values, latest, endpoint }) => {
      const color = latest > 0 ? palette.positive : latest < 0 ? palette.negative : palette.muted
      series.push({
        id: item.sector_code,
        name: displayName(item.sector_name),
        type: 'line',
        data: values,
        encode: { x: 0, y: 1 },
        showSymbol: false,
        triggerLineEvent: true,
        cursor: 'pointer',
        sampling: 'lttb',
        animationDurationUpdate: 300,
        lineStyle: { width: Math.abs(latest) > 1e9 ? 2 : 1.2, color, opacity: 0.82 },
        itemStyle: { color },
        emphasis: { focus: 'series', lineStyle: { width: 4, opacity: 1 } },
        blur: { lineStyle: { opacity: 0.08 } },
      })

      if (!endpoint) return

      const labelY = labelYByCode.get(item.sector_code) ?? Number(endpoint[1])
      series.push({
        id: `${item.sector_code}-label-connector`,
        name: `${displayName(item.sector_name)} label connector`,
        type: 'line',
        data: [endpoint, [MAIN_LABEL_ANCHOR_SECONDS, labelY]],
        encode: { x: 0, y: 1 },
        showSymbol: true,
        triggerLineEvent: true,
        cursor: 'pointer',
        symbol: 'circle',
        symbolSize: 4,
        tooltip: { show: false },
        animationDurationUpdate: 300,
        z: 2,
        lineStyle: { width: 1, color, opacity: 0.34 },
        itemStyle: { color, opacity: 0.72 },
        endLabel: {
          show: true,
          distance: 7,
          align: 'left',
          verticalAlign: 'middle',
          color,
          fontSize: 12,
          fontWeight: 600,
          formatter: () => `${displayName(item.sector_name)}  ${formatYi(latest)}`,
        },
        labelLayout: { hideOverlap: false },
        emphasis: { disabled: true },
      })

      series.push({
        id: `${item.sector_code}-endpoint`,
        name: `${displayName(item.sector_name)} endpoint`,
        type: 'scatter',
        data: [endpoint],
        encode: { x: 0, y: 1 },
        symbol: 'circle',
        symbolSize: 6,
        silent: true,
        tooltip: { show: false },
        z: 4,
        itemStyle: { color, opacity: 0.65, borderWidth: 0 },
      })

      if (flashingEndpoints.has(item.sector_code)) {
        series.push({
          id: `${item.sector_code}-endpoint-flash`,
          name: `${displayName(item.sector_name)} endpoint update`,
          type: 'effectScatter',
          data: [endpoint],
          encode: { x: 0, y: 1 },
          symbol: 'circle',
          symbolSize: 6,
          silent: true,
          tooltip: { show: false },
          z: 5,
          itemStyle: { color, opacity: 0.25 },
          rippleEffect: { period: 1.2, scale: 1.8, brushType: 'stroke' },
        })
      }
    })

    return {
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 300,
      grid: { left: 60, right: 158, top: 32, bottom: 38, containLabel: true },
      tooltip: { show: false },
      xAxis: {
        type: 'value',
        min: 0,
        max: MAIN_LABEL_ANCHOR_SECONDS,
        interval: 30 * 60,
        axisLabel: {
          color: palette.muted,
          hideOverlap: true,
          showMinLabel: true,
          showMaxLabel: true,
          formatter: (value: number) => (
            value > FULL_SESSION_SECONDS ? '' : tradingAxisLabel(value)
          ),
        },
        axisLine: { lineStyle: { color: palette.axis } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: yMin,
        max: yMax,
        name: '主力净流入（亿元）',
        nameLocation: 'middle',
        nameRotate: 90,
        nameGap: 48,
        nameTextStyle: { color: palette.muted },
        axisLabel: { color: palette.muted, formatter: (value: number) => value.toFixed(1) },
        splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      },
      series,
    }
  }, [flashingEndpoints, history.series, latestByCode, visibleCodes, palette])

  useEffect(() => {
    chartOptionRef.current = chartOption
    chartRef.current?.setOption(chartOption, { notMerge: true })
    highlightedCodeRef.current = null
    highlightSector(hoveredCodeRef.current ?? pinnedCodeRef.current)
  }, [chartOption, highlightSector])

  useEffect(() => {
    if (chartMode !== 'main') return
    const frame = requestAnimationFrame(() => chartRef.current?.resize())
    return () => cancelAnimationFrame(frame)
  }, [chartMode])

  const aggregates = useMemo(() => {
    return Object.fromEntries(FLOW_METRICS.map(([key]) => [
      key,
      visibleLatest.reduce((sum, flow) => sum + flow[key], 0),
    ])) as Record<(typeof FLOW_METRICS)[number][0], number>
  }, [visibleLatest])

  const inflowCount = visibleLatest.filter((flow) => flow.main_net > 0).length
  const outflowCount = visibleLatest.filter((flow) => flow.main_net < 0).length
  const leader = [...visibleLatest].sort((a, b) => b.main_net - a.main_net)[0]
  const radarTurns = radar.sectors.filter((sector) => sector.turned_positive)
    .sort((a, b) => (b.turn_time ?? 0) - (a.turn_time ?? 0)).slice(0, 8)
  const radarRising = radar.sectors.filter((sector) => sector.change_15s !== null)
    .sort((a, b) => (b.change_15s ?? 0) - (a.change_15s ?? 0)).slice(0, 10)
  const radarFalling = radar.sectors.filter((sector) => sector.change_15s !== null)
    .sort((a, b) => (a.change_15s ?? 0) - (b.change_15s ?? 0)).slice(0, 10)
  const radarFocused = radar.sectors.find((sector) => sector.sector_code === radarFocusedCode)
    ?? radarTurns[0] ?? radarRising[0] ?? null
  const activeDetailPage = detailPages[detailPage]
  const detailTotalPages = Math.max(
    1,
    activeDetailPage?.total_pages
      ?? Math.ceil((history.selection.length || 30) / DETAIL_PAGE_SIZE),
  )
  const detailTotalItems = activeDetailPage?.total_items ?? history.selection.length
  const detailRangeStart = detailTotalItems ? (detailPage - 1) * DETAIL_PAGE_SIZE + 1 : 0
  const detailRangeEnd = Math.min(detailPage * DETAIL_PAGE_SIZE, detailTotalItems)
  const activeDailyPage = dailyPages[dailyPage]
  const dailyTotalPages = Math.max(
    1,
    activeDailyPage?.total_pages
      ?? Math.ceil((history.selection.length || 30) / DETAIL_PAGE_SIZE),
  )
  const dailyTotalItems = activeDailyPage?.total_items ?? history.selection.length
  const dailyRangeStart = dailyTotalItems ? (dailyPage - 1) * DETAIL_PAGE_SIZE + 1 : 0
  const dailyRangeEnd = Math.min(dailyPage * DETAIL_PAGE_SIZE, dailyTotalItems)
  const dailyLoading = dailyLoadingPage === dailyPage
  const dailyLastDate = activeDailyPage?.series
    .flatMap((series) => series.points.at(-1)?.[0] ?? [])
    .sort()
    .at(-1)
  const stockLastTime = stockHistory?.points.at(-1)?.[0] ?? null
  const chooseStock = (stock: StockSearchResult) => {
    const nextRecent = rememberStock(recentStocks, stock)
    setRecentStocks(nextRecent)
    try {
      window.localStorage.setItem(STOCK_RECENTS_STORAGE_KEY, JSON.stringify(nextRecent))
    } catch {
      // The visible list still works when browser storage is disabled.
    }
    if (selectedStock?.quote_id !== stock.quote_id) {
      setSelectedStock(stock)
      setStockHistory(null)
      setStockError(null)
    }
    setStockQuery('')
    setStockSearchResults([])
  }
  const reloadDailyPage = () => {
    setDailyError(null)
    setDailyPages((pages) => {
      const next = { ...pages }
      delete next[dailyPage]
      return next
    })
  }
  const activeViewError = chartMode === 'detail'
    ? detailError
    : chartMode === 'daily'
      ? dailyError
      : chartMode === 'stock'
        ? stockError
        : null
  const isDelayed = (history.status.market_status === 'stale'
    || history.status.market_status === 'open')
    && !!history.status.last_source_time
    && Date.now() / 1000 - history.status.last_source_time > 30

  const activeView = WORKSPACE_VIEWS.find((view) => view.id === chartMode)!
  const mainTotal = aggregates.main_net ?? 0
  const flowScale = Math.max(1, ...FLOW_METRICS.map(([key]) => Math.abs(aggregates[key] ?? 0)))
  const leaderPoints = history.series.find((series) => series.sector_code === leader?.sector_code)?.points ?? []
  const rankedSectors = [...visibleLatest].sort((a, b) => b.main_net - a.main_net)
  const viewNotice = chartMode === 'stock' ? stockError : (
    loadError || activeViewError || history.status.universe_warning || history.status.last_error || history.status.backfill_error
    || (isDelayed ? '数据源更新时间超过30秒，当前显示最近可用数据。' : null)
  )

  return (
    <ThemeContext.Provider value={theme}>
    <main className="workbench">
      <aside className="workspace-sidebar">
        <a className="brand" href="#main" onClick={() => setChartMode('main')} aria-label="CapitalPulse 资金总览">
          <span className="brand-mark"><Activity size={23} strokeWidth={2.4} /></span>
          <span><strong>A · Flow</strong><small>资金流动 · A 股工作台</small></span>
        </a>
        <div className="nav-section-label">研究工作台 <span>WORKSPACE</span></div>
        <nav className="workspace-navigation" aria-label="主要功能">
          {WORKSPACE_VIEWS.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} onClick={() => navigateView(id)} aria-current={chartMode === id ? 'page' : undefined} className={`nav-item ${chartMode === id ? 'is-active' : ''}`}>
              <Icon size={18} strokeWidth={1.7} /><span>{label}</span>
              {id === 'radar' && <span className="nav-tag">{history.status.market_status === 'open' ? 'LIVE' : '15s'}</span>}
              {chartMode === id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-market-note">
          <span className="eyebrow">MARKET FLOW</span>
          <div><span className={`status-dot ${history.status.market_status === 'open' ? 'is-live' : ''}`} />{statusLabel(history.status.market_status)}</div>
          <p>{history.status.market_status === 'closed' ? '收盘后保留当日资金轨迹，等待下一交易日。' : '跟随资金流向，观察市场每一次变化。'}</p>
        </div>
        <div className="sidebar-footer">
          <div className="theme-control" role="group" aria-label="界面主题">
            <button type="button" onClick={() => changeTheme('light')} aria-pressed={theme === 'light'}><Sun size={15} />Light</button>
            <button type="button" onClick={() => changeTheme('dark')} aria-pressed={theme === 'dark'}><Moon size={15} />Dark</button>
          </div>
          <div className="sidebar-footnote"><span className="brand-mini">A</span><div>A · Flow<small>专注资金，洞察轮动</small></div></div>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="workspace-topbar">
          <div className="breadcrumb"><span>工作台</span><ChevronRight size={13} /><strong>{activeView.label}</strong></div>
          <div className="topbar-actions">
            <button type="button" className="workspace-search" onClick={() => { navigateView('stock'); setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="搜索股票名称或代码"]')?.focus(), 80) }}><Search size={16} /><span>搜索股票名称或代码</span></button>
            <span className="market-chip"><span className="status-dot" />A 股市场</span>
          </div>
        </header>

        <div className="workspace-content">
          <div className="page-heading">
            <div><p className="eyebrow">{activeView.english}</p><h1>{activeView.label}<span className="heading-dot">.</span></h1><p className="page-description">{activeView.description}</p></div>
            <div className="session-summary"><span className={`session-pill ${history.status.market_status === 'open' ? 'is-live' : ''}`}><span className="status-dot" />{statusLabel(history.status.market_status)}</span><span><Clock3 size={13} />{history.trade_date || '--'} · {formatTime(history.status.last_source_time)}</span></div>
          </div>

          {viewNotice && <div className="workspace-notice" role="status"><CircleAlert size={15} /><span>{viewNotice}</span><span className="notice-tag">数据状态</span></div>}

          {chartMode === 'main' && (
            <section className="overview-grid" aria-label="市场资金概览">
              <article className="overview-card balance-card">
                <div className="card-eyebrow"><span>主力净流入</span><Activity size={16} /></div>
                <div className={`overview-number ${mainTotal >= 0 ? 'flow-positive' : 'flow-negative'}`}>{formatYi(mainTotal)}<span>CNY</span></div>
                <p className="overview-caption">当前展示 {visibleSelection.length} 个板块合计</p>
                <div className="balance-footer"><span><ArrowUpRight size={14} />净流入 <b>{inflowCount}</b></span><span><ArrowDownLeft size={14} />净流出 <b>{outflowCount}</b></span><span className="subtle-tag">{history.status.universe_count ? '动态 15 + 15' : '历史快照'}</span></div>
              </article>
              <article className="overview-card leader-card">
                <div className="card-eyebrow"><span>资金领先板块</span><span className="subtle-tag purple">TOP SECTOR</span></div>
                <div className="leader-body"><div><h2>{leader ? displayName(leader.sector_name) : '--'}</h2><span className={leader && leader.main_net >= 0 ? 'flow-positive' : 'flow-negative'}>{leader ? formatYi(leader.main_net) : '--'}</span></div><MiniSparkline points={leaderPoints} positive={!leader || leader.main_net >= 0} /></div>
                <div className="leader-footer"><span>当日累计资金走势</span><span>截至 {formatTime(leader?.source_time)}</span></div>
              </article>
              <article className="overview-card structure-card">
                <div className="card-eyebrow"><span>资金结构</span><span className="muted">当前板块合计</span></div>
                <div className="structure-bars">{FLOW_METRICS.map(([key, label]) => { const value = aggregates[key] ?? 0; return <div className="structure-row" key={key}><span>{label}</span><div className="structure-track"><i style={{ width: `${Math.max(2, Math.abs(value) / flowScale * 100)}%`, background: value >= 0 ? 'var(--flow-positive)' : 'var(--flow-negative)' }} /></div><strong className={value >= 0 ? 'flow-positive' : 'flow-negative'}>{formatYi(value)}</strong></div> })}</div>
              </article>
            </section>
          )}

          <div className="view-layout">
          <section className="workspace-panel">
            <div className="workspace-panel-header">
              <div className="panel-title"><span className="panel-title-icon"><activeView.icon size={17} /></span><div><span className="eyebrow">{chartMode === 'main' ? 'INTRADAY CAPITAL FLOW' : activeView.english}</span><h2>{chartMode === 'main' ? '主力资金累计' : activeView.label}</h2></div></div>
              <div className="min-w-0 text-right">
                {chartMode === 'main' || chartMode === 'daily' || chartMode === 'radar' ? (
                  <div className="mt-1 flex flex-wrap items-center justify-end gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-red-600" />净流入</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-600" />净流出</span>
                    <span className="flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {chartMode === 'main' || chartMode === 'radar'
                        ? formatTime(history.status.last_source_time)
                        : `日频 · 截至 ${dailyLastDate ?? '--'}`}
                    </span>
                  </div>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-slate-500">
                    {DETAIL_METRICS.map((metric) => (
                      <span key={metric.key} className="flex items-center gap-1">
                        <span className="size-2 rounded-full" style={{ backgroundColor: metric.color }} />
                        {metric.label}
                      </span>
                    ))}
                    <span className="flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {chartMode === 'detail'
                        ? formatTime(history.status.last_source_time)
                        : `${formatTime(stockLastTime)} · ${statusLabel(stockMarketStatus)}`}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {chartMode === 'radar' && (
              <div className="min-h-[560px] bg-slate-50/70 p-4 dark:bg-slate-950/40">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>扫描 {radar.scanned_count} / {history.status.universe_count ?? 0} 个二级行业 · 15 秒资金变化排序 · 由负转正信号保留 5 分钟</span>
                  <span>源时间 {formatTime(radar.source_time)}</span>
                </div>
                {radar.sectors.length === 0 ? (
                  <div className="radar-empty">
                    <div className="radar-empty-icon"><Radar size={38} strokeWidth={1.2} /></div>
                    <h3>{history.status.market_status === 'closed' ? '休市期间暂停异动监测' : '等待市场的下一次脉冲'}</h3>
                    <p>盘中扫描全部可用二级行业，捕捉短时资金变化与由负转正。</p>
                    <div className="radar-window-labels"><span>15 秒 · 短时变化</span><span>1 分钟 · 资金方向</span><span>3 分钟 · 持续性</span></div>
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                    <div className="grid gap-4 lg:grid-cols-3">
                      {[
                        { title: '由负转正', description: '最近 5 分钟内跨过零轴', sectors: radarTurns, empty: '暂无新信号' },
                        { title: '短时流入加速', description: '15 秒主力净流入增量', sectors: radarRising, empty: '正在积累 15 秒数据' },
                        { title: '短时流出加速', description: '15 秒主力净流出增量', sectors: radarFalling, empty: '正在积累 15 秒数据' },
                      ].map((group) => (
                        <section key={group.title} className="min-w-0 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                          <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                            <h3 className="text-sm font-semibold">{group.title}</h3>
                            <p className="mt-0.5 text-xs text-slate-500">{group.description}</p>
                          </div>
                          <div className="max-h-[550px] overflow-y-auto p-2">
                            {group.sectors.length === 0 && <p className="p-3 text-xs text-slate-500">{group.empty}</p>}
                            {group.sectors.map((sector) => (
                              <button
                                key={sector.sector_code}
                                type="button"
                                onClick={() => setRadarFocusedCode(sector.sector_code)}
                                className={`mb-1 w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 ${radarFocused?.sector_code === sector.sector_code ? 'border-slate-400 bg-slate-50 dark:border-slate-500 dark:bg-slate-800' : 'border-transparent'}`}
                              >
                                <div className="flex items-center justify-between gap-2 text-sm">
                                  <span className="truncate font-medium">{displayName(sector.sector_name)}</span>
                                  <span className={`shrink-0 font-mono ${sector.main_net >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatYi(sector.main_net)}</span>
                                </div>
                                <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                                  <span>15秒 {sector.change_15s === null ? '--' : formatYi(sector.change_15s)}</span>
                                  <span>1分 {sector.change_1m === null ? '--' : formatYi(sector.change_1m)}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                    <aside className="self-start rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                      {radarFocused ? (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-xs text-slate-500">当前观察板块</div>
                              <h3 className="mt-1 text-lg font-semibold">{displayName(radarFocused.sector_name)}</h3>
                            </div>
                            {radarFocused.turned_positive && <span className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-600 dark:bg-red-950/50">由负转正</span>}
                          </div>
                          <div className={`mt-3 font-mono text-2xl font-semibold ${radarFocused.main_net >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatYi(radarFocused.main_net)}</div>
                          <p className="mt-1 text-xs text-slate-500">当日主力资金累计净流入</p>
                          <div className="mt-5 grid grid-cols-3 gap-2 text-xs">
                            {([['15秒', radarFocused.change_15s], ['1分钟', radarFocused.change_1m], ['3分钟', radarFocused.change_3m]] as const).map(([label, value]) => (
                              <div key={label} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800">
                                <div className="text-slate-500">{label}变化</div>
                                <div className={`mt-1 font-mono font-semibold ${value === null ? 'text-slate-400' : value >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{value === null ? '--' : formatYi(value)}</div>
                              </div>
                            ))}
                          </div>
                          <div className="mt-5 border-t border-slate-100 pt-3 dark:border-slate-800">
                            <p className="mb-2 text-xs text-slate-500">最近 4 分钟累计资金轨迹</p>
                            <RadarSparkline points={radarFocused.points} />
                            <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                              <span>{formatTime(radarFocused.points[0]?.[0])}</span>
                              <span>{formatTime(radarFocused.source_time)}</span>
                            </div>
                          </div>
                          <p className="mt-4 text-[11px] leading-4 text-slate-500">排名依据为资金增量，需结合价格、成交量确认；信号仅供观察。</p>
                        </>
                      ) : <p className="text-sm text-slate-500">选择左侧板块查看资金变化。</p>}
                    </aside>
                  </div>
                )}
              </div>
            )}

            {chartMode === 'main' && <div className="chart-scroll-hint">左右滑动，查看完整资金曲线 <ArrowUpRight size={12} /></div>}
            <div className={chartMode === 'main' ? 'main-chart-layout flex min-h-[480px] flex-col xl:flex-row' : 'hidden'}>
              <div className="main-chart-canvas">
                <div ref={chartContainer} className="absolute inset-0" aria-label="行业主力资金实时曲线" />
                {!loading && history.series.length > 0 && (
                  <div className="pointer-events-none absolute left-[76px] top-2 z-10 flex max-w-[calc(100%-90px)] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white/95 px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm sm:left-[150px] sm:max-w-[calc(100%-164px)] dark:border-slate-700 dark:bg-slate-900/95">
                    {focusedSector ? (
                      <>
                        <span className="text-slate-500">
                          {focusedCode === pinnedCode ? '已固定' : '当前曲线'}
                        </span>
                        <strong className="text-sm text-slate-900 dark:text-slate-100">
                          {displayName(focusedSector.sector_name)}
                        </strong>
                        <span className={focusedLatest >= 0 ? 'font-mono text-red-600' : 'font-mono text-emerald-600'}>
                          最新 {formatYi(focusedLatest)}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-500">悬停曲线或右侧板块名称查看，点击固定</span>
                    )}
                    {pinnedCode && (
                      <button
                        type="button"
                        onClick={() => {
                          pinnedCodeRef.current = null
                          setPinnedCode(null)
                          highlightSector(hoveredCodeRef.current)
                        }}
                        className="pointer-events-auto rounded px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        取消固定
                      </button>
                    )}
                  </div>
                )}
                {loading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-slate-500 backdrop-blur-sm dark:bg-slate-900/70">
                    <Radio className="mr-2 size-4 animate-pulse" />正在加载今日资金数据…
                  </div>
                )}
                {!loading && history.series.length === 0 && !loadError && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
                    当前还没有今日快照，开盘后将自动开始绘制。
                  </div>
                )}
              </div>
              {pinnedCode && (
                <aside className="flex max-h-[640px] flex-col border-t border-slate-200 bg-slate-50/80 xl:w-[300px] xl:shrink-0 xl:border-l xl:border-t-0 dark:border-slate-800 dark:bg-slate-950/50" aria-label={`${displayName(pinnedSector?.sector_name ?? '板块')}短线活跃候选`}>
                  <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-xs text-slate-500">{displayName(pinnedSector?.sector_name ?? pinnedCode)}</div>
                        <h3 className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">短线活跃候选</h3>
                      </div>
                      <button type="button" onClick={() => setCandidateRefresh((value) => value + 1)} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800">刷新</button>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-slate-500">
                      {candidateData?.sector_code === pinnedCode
                        ? `东方财富${candidateData.stale ? '缓存' : ''} · ${formatQuoteDateTime(candidateData.as_of)} · 已筛 ${candidateData.scanned_constituents}/${candidateData.total_constituents} 只`
                        : '按板块成分股最新行情筛选'}
                    </p>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                    {candidateLoading && <div className="py-8 text-center text-xs text-slate-500">正在筛选成分股…</div>}
                    {!candidateLoading && candidateError && (
                      <div className="py-8 text-center text-xs text-amber-600">候选加载失败：{candidateError}</div>
                    )}
                    {!candidateLoading && !candidateError && candidateData?.sector_code === pinnedCode && candidateData.candidates.length === 0 && (
                      <div className="py-8 text-center text-xs text-slate-500">当前没有满足条件的成分股</div>
                    )}
                    {!candidateLoading && !candidateError && candidateData?.sector_code === pinnedCode && candidateData.candidates.map((stock, index) => (
                      <button
                        key={stock.quote_id}
                        type="button"
                        onClick={() => { chooseStock(stock); navigateView('stock') }}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500"
                        aria-label={`查看${stock.name}个股资金曲线`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-slate-100"><span className="mr-1.5 text-xs font-normal text-slate-400">{index + 1}.</span>{stock.name}</span>
                          <span className="shrink-0 font-mono text-xs text-slate-500">{stock.code}</span>
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                          <span className="font-mono text-slate-700 dark:text-slate-300">¥{stock.price.toFixed(2)}</span>
                          <span className="font-mono font-medium text-red-600">+{stock.change_percent.toFixed(2)}%</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
                          <span>主力 {formatYi(stock.main_net)}</span>
                          <span>换手 {stock.turnover_rate.toFixed(1)}%</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
                          <span>成交 {(stock.amount / 1e8).toFixed(1)}亿</span>
                          {stock.volume_ratio && <span>量比 {stock.volume_ratio.toFixed(1)}</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="border-t border-slate-200 px-3 py-2 text-[11px] leading-4 text-slate-500 dark:border-slate-800">
                    筛选：成交额≥1亿、换手≥1%、涨幅 0–8%、主力净流入为正；排除 ST。仅供观察，不构成买卖建议。A股当日买入通常次日才能卖出。
                  </p>
                </aside>
              )}
            </div>

            {chartMode === 'detail' && (
              <div className="flex h-[480px] min-h-[420px] flex-col bg-slate-50 sm:h-[560px] lg:h-[640px] dark:bg-slate-950/40">
                <div className="border-b border-slate-200 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
                  {detailRangeStart || '--'}–{detailRangeEnd || '--'} / {detailTotalItems || 30} 行业
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {detailLoadingPage === detailPage && !activeDetailPage && (
                    <div className="flex h-full items-center justify-center text-sm text-slate-500">
                      <Radio className="mr-2 size-4 animate-pulse" />正在加载行业细分曲线…
                    </div>
                  )}
                  {detailError && !activeDetailPage && (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-slate-500">
                      <span>行业细分曲线加载失败：{detailError}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailError(null)
                          setDetailPages((pages) => ({ ...pages }))
                        }}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {activeDetailPage && activeDetailPage.series.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 p-3 xl:h-full xl:grid-cols-3 xl:grid-rows-2">
                      {activeDetailPage.series.map((sector) => (
                        <DetailSectorChart
                          key={sector.sector_code}
                          sector={sector}
                          flashing={flashingEndpoints.has(sector.sector_code)}
                        />
                      ))}
                    </div>
                  )}
                  {activeDetailPage && activeDetailPage.series.length === 0 && (
                    <div className="flex h-full items-center justify-center text-sm text-slate-500">
                      当前还没有行业细分历史数据。
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-center gap-2 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setDetailPage((page) => Math.max(1, page - 1))}
                    disabled={detailPage <= 1}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ChevronLeft className="size-3.5" />上一页
                  </button>
                  <span className="min-w-12 text-center font-mono tabular-nums">{detailPage} / {detailTotalPages}</span>
                  <button
                    type="button"
                    onClick={() => setDetailPage((page) => Math.min(detailTotalPages, page + 1))}
                    disabled={detailPage >= detailTotalPages}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    下一页<ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>
            )}

            {chartMode === 'daily' && (
              <div className="relative flex h-[480px] min-h-[420px] flex-col bg-slate-50 sm:h-[560px] lg:h-[640px] dark:bg-slate-950/40">
                <div className="border-b border-slate-200 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
                  {dailyRangeStart || '--'}–{dailyRangeEnd || '--'} / {dailyTotalItems || 30} 行业
                </div>

                <div className="relative min-h-0 flex-1 overflow-y-auto">
                  {dailyLoading && !activeDailyPage && (
                    <div className="flex h-full items-center justify-center bg-white/70 text-sm text-slate-500 backdrop-blur-sm dark:bg-slate-900/70">
                    <Radio className="mr-2 size-4 animate-pulse" />正在拉取30日日频资金数据…
                    </div>
                  )}
                  {dailyError && !activeDailyPage && !dailyLoading && (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-slate-500">
                      <span>30日日频资金数据加载失败：{dailyError}</span>
                      <button
                        type="button"
                        onClick={reloadDailyPage}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {activeDailyPage && activeDailyPage.series.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 p-3 xl:h-full xl:grid-cols-3 xl:grid-rows-2">
                      {activeDailyPage.series.map((sector) => (
                        <DailySectorChart key={sector.sector_code} sector={sector} />
                      ))}
                    </div>
                  )}
                  {activeDailyPage && activeDailyPage.series.length === 0 && !dailyLoading && !dailyError && (
                    <div className="flex h-full items-center justify-center text-sm text-slate-500">
                      当前还没有30日日频资金数据。
                    </div>
                  )}
                  {activeDailyPage && (
                    activeDailyPage.failed_codes.length > 0
                    || (activeDailyPage.refresh_failed_codes?.length ?? 0) > 0
                  ) && (
                    <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md bg-amber-50/90 px-2 py-1 text-xs text-amber-700 shadow-sm dark:bg-amber-950/80 dark:text-amber-300">
                      <span>
                        {activeDailyPage.failed_codes.length > 0
                          ? `${activeDailyPage.failed_codes.length} 个行业日频数据暂未返回`
                          : `${activeDailyPage.refresh_failed_codes?.length ?? 0} 个行业更新失败，已显示本地缓存`}
                      </span>
                      <button
                        type="button"
                        onClick={reloadDailyPage}
                        disabled={dailyLoading}
                        className="rounded border border-amber-300/80 bg-white/60 px-1.5 py-0.5 font-medium transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950/50 dark:hover:bg-amber-900"
                      >
                        {dailyLoading ? '补拉中…' : '补拉'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-center gap-2 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setDailyPage((page) => Math.max(1, page - 1))}
                    disabled={dailyPage <= 1}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ChevronLeft className="size-3.5" />上一页
                  </button>
                  <span className="min-w-12 text-center font-mono tabular-nums">{dailyPage} / {dailyTotalPages}</span>
                  <button
                    type="button"
                    onClick={() => setDailyPage((page) => Math.min(dailyTotalPages, page + 1))}
                    disabled={dailyPage >= dailyTotalPages}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    下一页<ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>
            )}

            {chartMode === 'stock' && (
              <div className="flex h-[480px] min-h-[420px] flex-col bg-slate-50 sm:h-[560px] lg:h-[640px] dark:bg-slate-950/40">
                <div className="stock-toolbar flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                  <div className="stock-search relative min-w-[240px] flex-1 sm:max-w-md">
                    <Search className="stock-search-icon" size={16} />
                    <input
                      type="search"
                      value={stockQuery}
                      onChange={(event) => setStockQuery(event.target.value)}
                      placeholder="输入股票名称或代码，例如：贵州茅台 / 600519"
                      className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-500 dark:focus:ring-slate-800"
                      aria-label="搜索股票名称或代码"
                    />
                    {stockQuery.trim() && (
                      <div className="absolute left-0 right-0 top-11 z-30 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                        {stockSearching && (
                          <div className="flex items-center justify-center px-3 py-4 text-xs text-slate-500">
                            <Radio className="mr-2 size-3.5 animate-pulse" />正在搜索股票…
                          </div>
                        )}
                        {!stockSearching && stockSearchError && (
                          <div className="px-3 py-4 text-center text-xs text-amber-600">{stockSearchError}</div>
                        )}
                        {!stockSearching && !stockSearchError && stockSearchResults.length === 0 && (
                          <div className="px-3 py-4 text-center text-xs text-slate-500">未找到匹配的 A 股股票</div>
                        )}
                        {!stockSearching && stockSearchResults.map((stock) => (
                          <button
                            key={stock.quote_id}
                            type="button"
                            onClick={() => chooseStock(stock)}
                            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <span className="font-medium">{stock.name}</span>
                            <span className="font-mono text-xs text-slate-500">{stock.code} · {stock.market_name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div
                    className="flex min-w-0 flex-1 basis-full items-center gap-2 overflow-x-auto pb-1 sm:basis-0"
                    role="group"
                    aria-label="最近查看的股票"
                  >
                    <span className="shrink-0 text-xs text-slate-500">最近查看</span>
                    {recentStocks.length === 0 && (
                      <span className="shrink-0 text-xs text-slate-400">搜索并选择股票后会显示在这里</span>
                    )}
                    {recentStocks.map((stock) => {
                      const active = selectedStock?.quote_id === stock.quote_id
                      return (
                        <button
                          key={stock.quote_id}
                          type="button"
                          onClick={() => chooseStock(stock)}
                          aria-pressed={active}
                          title={`${stock.name} ${stock.code}`}
                          className={`flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
                            active
                              ? 'border-slate-400 bg-slate-100 text-slate-950 dark:border-slate-500 dark:bg-slate-800 dark:text-white'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-950 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-white'
                          }`}
                        >
                          <span className="font-medium">{stock.name}</span>
                          <span className="font-mono text-xs text-slate-500">{stock.code}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {selectedStock && <div className="stock-context-bar"><div className="stock-identity"><span className="stock-avatar">{selectedStock.name.slice(0, 1)}</span><div><h3>{selectedStock.name}</h3><span className="mono">{selectedStock.code} · {selectedStock.market_name}</span></div></div><div className="stock-main-value"><span>主力净流入</span><strong className={(stockHistory?.points.at(-1)?.[1] ?? 0) >= 0 ? 'flow-positive mono' : 'flow-negative mono'}>{stockHistory?.points.length ? formatYi(stockHistory.points.at(-1)![1]) : '--'}</strong></div></div>}
                <div className="relative min-h-0 flex-1">
                  {selectedStock && stockHistory && stockHistory.points.length > 0 && (
                    <StockFlowChart data={stockHistory} flashing={stockFlashing} />
                  )}
                  {!selectedStock && (
                    <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-slate-500">
                      请搜索并选择一只股票，查看主力、超大单、大单、中单和小单的秒级累计资金流向。
                    </div>
                  )}
                  {selectedStock && !stockHistory && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
                      <Radio className="mr-2 size-4 animate-pulse" />正在连接 {selectedStock.name} 的实时资金数据…
                    </div>
                  )}
                  {selectedStock && stockHistory && stockHistory.points.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-slate-500">
                      正在补全启动前的当日历史；盘中将按约 {stockHistory.poll_seconds} 秒持续采集。
                    </div>
                  )}
                  {selectedStock && (
                    <div className="absolute right-3 top-3 z-10 rounded-md bg-white/90 px-2 py-1 text-xs text-slate-500 shadow-sm dark:bg-slate-900/90">
                      {statusLabel(stockMarketStatus)} · {formatTime(stockLastTime)}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
          </div>

          {chartMode === 'main' && (
            <div className="research-grid">
              <section className="research-card">
                <div className="research-card-header"><h2><Bookmark size={16} />最近观察</h2><button type="button" onClick={() => navigateView('stock')}>个股研究 <ArrowUpRight size={14} /></button></div>
                <p className="research-caption">快速回到你关注的股票</p>
                <div className="watchlist-grid">{recentStocks.length ? recentStocks.slice(0, 4).map((stock) => <button type="button" className="watchlist-item" key={stock.quote_id} onClick={() => { chooseStock(stock); navigateView('stock') }}><span className="stock-avatar">{stock.name.slice(0, 1)}</span><strong>{stock.name}</strong><span className="mono">{stock.code}</span><span className="watchlist-link">资金走势 <ArrowUpRight size={12} /></span></button>) : <button type="button" className="watchlist-empty" onClick={() => navigateView('stock')}><Search size={20} /><span>搜索一只股票，开始观察它的资金走势</span><ArrowUpRight size={16} /></button>}</div>
              </section>
              <section className="research-card">
                <div className="research-card-header"><h2><Layers3 size={16} />板块资金榜</h2><span className="subtle-tag">当日净流入</span></div>
                <div className="sector-ranking">{rankedSectors.slice(0, 4).map((sector, index) => <button type="button" key={sector.sector_code} onClick={() => { pinnedCodeRef.current = sector.sector_code; setPinnedCode(sector.sector_code); highlightSector(sector.sector_code); document.querySelector('.workspace-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}><span className="rank-index">{String(index + 1).padStart(2, '0')}</span><strong>{displayName(sector.sector_name)}</strong><span className={sector.main_net >= 0 ? 'flow-positive mono' : 'flow-negative mono'}>{formatYi(sector.main_net)}</span><ArrowUpRight size={14} /></button>)}</div>
              </section>
            </div>
          )}
          <footer className="workspace-bottom"><span><Activity size={12} /> CAPITALPULSE</span><span>数据源：东方财富 · 资金流向仅供研究观察</span></footer>
        </div>
      </div>
    </main>
    </ThemeContext.Provider>
  )
}
