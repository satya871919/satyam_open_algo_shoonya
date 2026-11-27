import type {
  Chart,
  IndicatorDescriptor,
  IPrimitive,
  PrimitiveHit,
  PrimitiveHost,
  PrimitiveRenderContext,
  ZOrder,
} from 'openalgo-charts'
import { oiProfileApi } from '@/api/oi-profile'
import { optionChainApi } from '@/api/option-chain'
import type { OptionStrike } from '@/types/option-chain'

export const OI_PROFILE_INDICATOR_ID = 'open-interest-profile'

export interface OIProfileSettings {
  expiry: string
  strikes: number
  width: number
  refreshSec: number
  callColor: string
  putColor: string
  opacity: number
  showPercent: boolean
}

const DEFAULT_SETTINGS: OIProfileSettings = {
  expiry: '',
  strikes: 8,
  width: 96,
  refreshSec: 30,
  callColor: '#ef5350',
  putColor: '#26a69a',
  opacity: 72,
  showPercent: true,
}

export const OPEN_INTEREST_DESCRIPTOR: IndicatorDescriptor = {
  id: OI_PROFILE_INDICATOR_ID,
  name: 'Open Interest Shoonya',
  category: 'Volume',
  placement: 'onchart',
  inputs: [
    {
      key: 'expiry',
      type: 'text',
      label: 'Expiry (blank = nearest, e.g. 26NOV26)',
      default: DEFAULT_SETTINGS.expiry,
    },
    {
      key: 'strikes',
      type: 'number',
      label: 'Strikes Each Side (ATM ±)',
      default: DEFAULT_SETTINGS.strikes,
      min: 3,
      max: 25,
      step: 1,
    },
    {
      key: 'width',
      type: 'number',
      label: 'Max Bar Width (px)',
      default: DEFAULT_SETTINGS.width,
      min: 40,
      max: 240,
      step: 4,
    },
    {
      key: 'refreshSec',
      type: 'number',
      label: 'Auto Refresh (sec, 0 = off)',
      default: DEFAULT_SETTINGS.refreshSec,
      min: 0,
      max: 300,
      step: 5,
    },
    {
      key: 'callColor',
      type: 'color',
      label: 'Call OI Color',
      default: DEFAULT_SETTINGS.callColor,
    },
    {
      key: 'putColor',
      type: 'color',
      label: 'Put OI Color',
      default: DEFAULT_SETTINGS.putColor,
    },
    {
      key: 'opacity',
      type: 'number',
      label: 'Bar Opacity (%)',
      default: DEFAULT_SETTINGS.opacity,
      min: 15,
      max: 100,
      step: 5,
    },
    {
      key: 'showPercent',
      type: 'boolean',
      label: 'Show OI Share % in Tooltip',
      default: DEFAULT_SETTINGS.showPercent,
    },
  ],
  plots: [
    {
      key: '_oi',
      type: 'line',
      title: 'OI',
      style: {
        color: 'transparent',
        lineWidth: 0,
        visible: false,
      },
    },
  ],
  calc(bars) {
    return { _oi: new Array(bars.length).fill(null) }
  },
}

interface StrikeBarGeometry {
  strike: number
  ceOi: number
  peOi: number
  y: number
  topY: number
  bottomY: number
  hitLeftX: number
  rightX: number
}

export interface OptionTarget {
  underlying: string
  optionsExchange: string
}

const FUT_SUFFIX_RE = /^([A-Z0-9&-]+?)(\d{2}[A-Z]{3}\d{2}(?:FUT|CE|PE)?)$/i

export function resolveOptionTarget(symbol: string, exchange: string): OptionTarget | null {
  const sym = symbol.trim().toUpperCase()
  const ex = exchange.trim().toUpperCase()
  if (!sym || !ex) return null

  let optionsExchange = ex
  if (ex === 'NSE' || ex === 'NSE_INDEX') optionsExchange = 'NFO'
  else if (ex === 'BSE' || ex === 'BSE_INDEX') optionsExchange = 'BFO'
  else if (!['NFO', 'BFO', 'MCX', 'CDS', 'BCD'].includes(ex)) return null

  let underlying = sym
  if (ex === 'NFO' || ex === 'BFO' || ex === 'MCX' || ex === 'CDS' || ex === 'BCD') {
    const match = FUT_SUFFIX_RE.exec(sym)
    if (match?.[1]) underlying = match[1]
  }

  return { underlying, optionsExchange }
}

export function formatIndianOI(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)} Lac`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} K`
  return String(Math.round(value))
}

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
}

export function convertExpiryForAPI(expiry: string): string {
  const clean = expiry.trim().toUpperCase()
  if (!clean) return ''
  const parts = clean.split('-')
  if (parts.length === 3) {
    return `${parts[0].padStart(2, '0')}${parts[1]}${parts[2].slice(-2)}`
  }
  return clean.replace(/-/g, '')
}

function parseExpiryDateUTC(expiry: string): { year: number; month: number; day: number } | null {
  const api = convertExpiryForAPI(expiry)
  const match = /^(\d{2})([A-Z]{3})(\d{2,4})$/.exec(api)
  if (!match) return null
  const day = Number(match[1])
  const month = MONTHS[match[2]]
  if (month === undefined) return null
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])
  return { year, month, day }
}

/**
 * Pick the nearest non-expired expiry in IST.
 * On expiry day itself, once market close passes (15:30 IST for NFO/BFO,
 * 17:00 IST for CDS/BCD, 23:30 IST for MCX), automatically advance to the
 * next available expiry.
 */
export function pickActiveExpiries(
  expiries: readonly string[],
  optionsExchange: string,
  nowMs: number = Date.now()
): string[] {
  if (!expiries.length) return []
  const istMs = nowMs + 330 * 60 * 1000
  const ist = new Date(istMs)
  const todayKey = ist.getUTCFullYear() * 10000 + (ist.getUTCMonth() + 1) * 100 + ist.getUTCDate()
  const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes()

  const ex = optionsExchange.toUpperCase()
  const cutoffMinutes = ex === 'MCX' ? 23 * 60 + 30 : ex === 'CDS' || ex === 'BCD' ? 17 * 60 : 15 * 60 + 30

  const active = expiries.filter((exp) => {
    const parsed = parseExpiryDateUTC(exp)
    if (!parsed) return true
    const expKey = parsed.year * 10000 + (parsed.month + 1) * 100 + parsed.day
    if (expKey > todayKey) return true
    if (expKey < todayKey) return false
    return istMinutes < cutoffMinutes
  })

  return active.length > 0 ? active : [...expiries]
}

export function formatExpiryLabel(expiry: string): string {
  const clean = expiry.trim().toUpperCase().replace(/-/g, '')
  const match = /^(\d{2})([A-Z]{3})(\d{2,4})$/.exec(clean)
  if (!match) return expiry
  const day = Number(match[1])
  const monRaw = match[2]
  const mon = monRaw.charAt(0) + monRaw.slice(1).toLowerCase()
  const year = match[3].length === 2 ? `20${match[3]}` : match[3]
  return `${mon} ${day}, ${year}`
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function parseSettings(raw: Record<string, unknown> | undefined): OIProfileSettings {
  return {
    expiry: typeof raw?.expiry === 'string' ? raw.expiry.trim().toUpperCase() : DEFAULT_SETTINGS.expiry,
    strikes: clamp(Number(raw?.strikes ?? DEFAULT_SETTINGS.strikes) || DEFAULT_SETTINGS.strikes, 3, 25),
    width: clamp(Number(raw?.width ?? DEFAULT_SETTINGS.width) || DEFAULT_SETTINGS.width, 40, 240),
    refreshSec: clamp(
      raw?.refreshSec !== undefined ? Number(raw.refreshSec) : DEFAULT_SETTINGS.refreshSec,
      0,
      300
    ),
    callColor: typeof raw?.callColor === 'string' && raw.callColor ? raw.callColor : DEFAULT_SETTINGS.callColor,
    putColor: typeof raw?.putColor === 'string' && raw.putColor ? raw.putColor : DEFAULT_SETTINGS.putColor,
    opacity: clamp(Number(raw?.opacity ?? DEFAULT_SETTINGS.opacity) || DEFAULT_SETTINGS.opacity, 15, 100),
    showPercent:
      typeof raw?.showPercent === 'boolean' ? raw.showPercent : DEFAULT_SETTINGS.showPercent,
  }
}

class OIProfilePrimitive implements IPrimitive {
  private host: PrimitiveHost | null = null
  private chain: OptionStrike[] = []
  private settings: OIProfileSettings = { ...DEFAULT_SETTINGS }
  private hoveredStrike: number | null = null
  private geometries: StrikeBarGeometry[] = []

  attached(host: PrimitiveHost): void {
    this.host = host
  }

  detached(): void {
    this.host = null
    this.geometries = []
  }

  zOrder(): ZOrder {
    return 'top'
  }

  autoscaleInfo(): null {
    return null
  }

  setData(chain: OptionStrike[], settings: OIProfileSettings): void {
    this.chain = chain
    this.settings = settings
    this.host?.requestUpdate()
  }

  setHoveredStrike(strike: number | null): void {
    if (this.hoveredStrike === strike) return
    this.hoveredStrike = strike
    this.host?.requestUpdate()
  }

  getStrikeAt(x: number, y: number): StrikeBarGeometry | null {
    for (const g of this.geometries) {
      if (x >= g.hitLeftX && x <= g.rightX && y >= g.topY && y <= g.bottomY) {
        return g
      }
    }
    return null
  }

  hitTest(x: number, y: number): PrimitiveHit | null {
    const hit = this.getStrikeAt(x, y)
    if (!hit) return null
    return {
      externalId: OI_PROFILE_INDICATOR_ID,
      hoverKey: String(hit.strike),
      zOrder: 'top',
      distance: 0,
      cursor: 'pointer',
    }
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const geometries: StrikeBarGeometry[] = []
    this.geometries = geometries

    if (!this.chain.length || !rc.priceScale.scaled) return

    const rightX = rc.plotWidth
    const maxWidth = Math.min(this.settings.width, Math.max(40, rc.plotWidth * 0.35))
    const baseAlpha = this.settings.opacity / 100

    let maxOi = 0
    for (const item of this.chain) {
      const ceOi = item.ce?.oi ?? 0
      const peOi = item.pe?.oi ?? 0
      if (ceOi > maxOi) maxOi = ceOi
      if (peOi > maxOi) maxOi = peOi
    }
    if (maxOi <= 0) return

    const sorted = [...this.chain].sort((a, b) => a.strike - b.strike)
    const ys = sorted.map((s) => rc.priceScale.priceToY(s.strike))

    let minGap = 18
    for (let i = 1; i < ys.length; i++) {
      const gap = Math.abs(ys[i] - ys[i - 1])
      if (gap > 1 && gap < minGap) minGap = gap
    }
    const slotH = clamp(minGap * 0.72, 4, 16)
    const halfBar = Math.max(2, (slotH - 1) / 2)

    ctx.save()
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i]
      const y = ys[i]
      if (!Number.isFinite(y) || y < -slotH || y > rc.plotHeight + slotH) continue

      const ceOi = item.ce?.oi ?? 0
      const peOi = item.pe?.oi ?? 0
      if (ceOi <= 0 && peOi <= 0) continue

      const ceW = ceOi > 0 ? Math.max(3, (ceOi / maxOi) * maxWidth) : 0
      const peW = peOi > 0 ? Math.max(3, (peOi / maxOi) * maxWidth) : 0
      const isHovered = this.hoveredStrike === item.strike

      if (isHovered) {
        ctx.save()
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(rightX, y)
        ctx.stroke()
        ctx.restore()
      }

      ctx.globalAlpha = isHovered ? Math.min(1, baseAlpha + 0.25) : baseAlpha

      if (ceW > 0) {
        ctx.fillStyle = this.settings.callColor
        ctx.fillRect(rightX - ceW, y - halfBar - 0.5, ceW, halfBar)
      }
      if (peW > 0) {
        ctx.fillStyle = this.settings.putColor
        ctx.fillRect(rightX - peW, y + 0.5, peW, halfBar)
      }

      const hitWidth = Math.max(ceW, peW, 24)
      geometries.push({
        strike: item.strike,
        ceOi,
        peOi,
        y,
        topY: y - halfBar - 3,
        bottomY: y + halfBar + 3,
        hitLeftX: Math.max(0, rightX - hitWidth - 8),
        rightX,
      })
    }
    ctx.restore()
  }
}

export interface OIProfileControllerOptions {
  container: HTMLElement
  apiKey: string
  getChart: () => Chart | null
  getSymbol: () => { symbol: string; exchange: string } | null
  isDark: () => boolean
}

export class OIProfileController {
  private readonly opts: OIProfileControllerOptions
  private primitive: OIProfilePrimitive | null = null
  private attachedChart: Chart | null = null
  private tooltipEl: HTMLDivElement | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private fetchSeq = 0
  private active = false
  private settings: OIProfileSettings = { ...DEFAULT_SETTINGS }
  private chain: OptionStrike[] = []
  private totalCeOi = 0
  private totalPeOi = 0
  private resolvedUnderlying = ''
  private resolvedExpiry = ''
  private lastFetchKey = ''
  private hoveredStrike: number | null = null
  private lastPointer = { x: 0, y: 0 }
  private disposed = false

  constructor(opts: OIProfileControllerOptions) {
    this.opts = opts
    this.bindPointerEvents()
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.active || !this.primitive || !this.attachedChart) {
      this.hideTooltip()
      return
    }
    const maximized = this.attachedChart.maximizedPane()
    if (maximized !== null && maximized !== 0) {
      this.hideTooltip()
      return
    }
    const rect = this.opts.container.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    this.lastPointer = { x: localX, y: localY }

    const plotLeft = this.getPlotLeft(this.attachedChart)
    const hit = this.primitive.getStrikeAt(localX - plotLeft, localY)
    if (!hit) {
      this.hideTooltip()
      return
    }

    this.hoveredStrike = hit.strike
    this.primitive.setHoveredStrike(hit.strike)
    this.showTooltip(hit, localX, localY)
  }

  private readonly onPointerLeave = () => {
    this.hideTooltip()
  }

  private getPlotLeft(chart: Chart): number {
    const time = chart.dataLayer.indexToTime(0)
    if (time === undefined) return 0
    const coord = chart.timeToCoordinate(time)
    const ix = chart.timeScale.indexToX(0)
    return Number.isFinite(coord) && Number.isFinite(ix) ? coord - ix : 0
  }

  private bindPointerEvents(): void {
    this.opts.container.addEventListener('pointermove', this.onPointerMove)
    this.opts.container.addEventListener('pointerleave', this.onPointerLeave)
  }

  sync(): void {
    if (this.disposed) return
    const chart = this.opts.getChart()
    if (!chart) {
      this.detachPrimitive()
      return
    }

    const inst = chart.indicators().find((i) => i.indicatorId === OI_PROFILE_INDICATOR_ID)
    const shouldShow = Boolean(inst && inst.visible())

    if (!shouldShow) {
      this.active = false
      this.stopTimer()
      this.hideTooltip()
      this.detachPrimitive()
      return
    }

    const nextSettings = parseSettings(inst?.settings())
    const settingsChanged =
      nextSettings.expiry !== this.settings.expiry ||
      nextSettings.strikes !== this.settings.strikes ||
      nextSettings.refreshSec !== this.settings.refreshSec

    this.settings = nextSettings
    this.active = true

    if (this.attachedChart !== chart) {
      this.detachPrimitive()
      this.primitive = new OIProfilePrimitive()
      chart.addPrimitive(this.primitive, 0)
      this.attachedChart = chart
    }

    this.primitive?.setData(this.chain, this.settings)

    const sym = this.opts.getSymbol()
    const targetKey = sym ? `${sym.exchange}:${sym.symbol}:${this.settings.expiry}:${this.settings.strikes}` : ''
    if (targetKey !== this.lastFetchKey || settingsChanged) {
      this.lastFetchKey = targetKey
      void this.refreshData()
      this.resetTimer()
    }
  }

  onSymbolChanged(): void {
    if (!this.active) return
    this.chain = []
    this.totalCeOi = 0
    this.totalPeOi = 0
    this.lastFetchKey = ''
    this.hideTooltip()
    this.primitive?.setData([], this.settings)
    this.sync()
  }

  private resetTimer(): void {
    this.stopTimer()
    if (!this.active || this.settings.refreshSec <= 0) return
    this.refreshTimer = setInterval(() => {
      if (this.active && document.visibilityState !== 'hidden') {
        void this.refreshData()
      }
    }, this.settings.refreshSec * 1000)
  }

  private stopTimer(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  async refreshData(): Promise<void> {
    if (this.disposed || !this.active) return
    const sym = this.opts.getSymbol()
    if (!sym) return
    const target = resolveOptionTarget(sym.symbol, sym.exchange)
    if (!target) {
      this.chain = []
      this.primitive?.setData([], this.settings)
      return
    }

    const seq = ++this.fetchSeq
    try {
      let candidates: string[] = []
      if (this.settings.expiry) {
        candidates = [convertExpiryForAPI(this.settings.expiry)]
      } else {
        let rawExpiries: string[] = []
        try {
          const searchExp = await oiProfileApi.getExpiries(
            target.optionsExchange,
            target.underlying
          )
          if (searchExp.status === 'success' && Array.isArray(searchExp.expiries)) {
            rawExpiries = searchExp.expiries
          }
        } catch {
          // Fall back to broker /expiry API below
        }
        if (seq !== this.fetchSeq || this.disposed) return

        if (rawExpiries.length === 0) {
          const expRes = await optionChainApi.getExpiries(
            this.opts.apiKey,
            target.underlying,
            target.optionsExchange,
            'options'
          )
          if (seq !== this.fetchSeq || this.disposed) return
          if (expRes.status === 'success' && Array.isArray(expRes.data)) {
            rawExpiries = expRes.data
          }
        }

        candidates = pickActiveExpiries(rawExpiries, target.optionsExchange).map(
          convertExpiryForAPI
        )
      }

      if (candidates.length === 0) return

      let chainRes: Awaited<ReturnType<typeof optionChainApi.getOptionChain>> | null = null
      let usedExpiry = candidates[0]
      for (const exp of candidates.slice(0, 2)) {
        const res = await optionChainApi.getOptionChain(
          this.opts.apiKey,
          target.underlying,
          target.optionsExchange,
          exp,
          this.settings.strikes
        )
        if (seq !== this.fetchSeq || this.disposed) return
        if (res.status === 'success' && Array.isArray(res.chain) && res.chain.length > 0) {
          chainRes = res
          usedExpiry = exp
          break
        }
      }

      if (!chainRes || !chainRes.chain) return

      const sortedChain = [...chainRes.chain].sort((a, b) => a.strike - b.strike)
      const atmRef = chainRes.atm_strike || chainRes.underlying_ltp || 0
      let slicedChain = sortedChain
      if (atmRef > 0 && sortedChain.length > this.settings.strikes * 2 + 1) {
        let atmIdx = 0
        let bestDist = Infinity
        for (let i = 0; i < sortedChain.length; i++) {
          const dist = Math.abs(sortedChain[i].strike - atmRef)
          if (dist < bestDist) {
            bestDist = dist
            atmIdx = i
          }
        }
        const start = Math.max(0, atmIdx - this.settings.strikes)
        const end = Math.min(sortedChain.length, atmIdx + this.settings.strikes + 1)
        slicedChain = sortedChain.slice(start, end)
      }

      let totalCe = 0
      let totalPe = 0
      for (const row of slicedChain) {
        totalCe += row.ce?.oi ?? 0
        totalPe += row.pe?.oi ?? 0
      }

      this.chain = slicedChain
      this.totalCeOi = totalCe
      this.totalPeOi = totalPe
      this.resolvedUnderlying = chainRes.underlying || target.underlying
      this.resolvedExpiry = chainRes.expiry_date || usedExpiry
      this.primitive?.setData(this.chain, this.settings)

      if (this.hoveredStrike !== null && this.primitive) {
        const plotLeft = this.attachedChart ? this.getPlotLeft(this.attachedChart) : 0
        const hit = this.primitive.getStrikeAt(this.lastPointer.x - plotLeft, this.lastPointer.y)
        if (hit) this.showTooltip(hit, this.lastPointer.x, this.lastPointer.y)
      }
    } catch {
      // Non-fatal: keep previous OI snapshot if a poll fails
    }
  }

  private ensureTooltip(): HTMLDivElement {
    if (this.tooltipEl) {
      if (!this.tooltipEl.isConnected) this.opts.container.appendChild(this.tooltipEl)
      return this.tooltipEl
    }
    const el = document.createElement('div')
    el.style.position = 'absolute'
    el.style.zIndex = '40'
    el.style.pointerEvents = 'none'
    el.style.minWidth = '210px'
    el.style.borderRadius = '8px'
    el.style.padding = '10px 12px'
    el.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, sans-serif'
    el.style.fontSize = '12px'
    el.style.lineHeight = '1.35'
    el.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.28)'
    el.style.display = 'none'
    this.opts.container.appendChild(el)
    this.tooltipEl = el
    return el
  }

  private showTooltip(hit: StrikeBarGeometry, localX: number, localY: number): void {
    const el = this.ensureTooltip()
    const dark = this.opts.isDark()
    el.style.background = dark ? 'rgba(24, 28, 36, 0.96)' : 'rgba(255, 255, 255, 0.98)'
    el.style.color = dark ? '#e5e7eb' : '#111827'
    el.style.border = dark ? '1px solid rgba(255, 255, 255, 0.12)' : '1px solid rgba(15, 23, 42, 0.12)'

    const muted = dark ? '#9ca3af' : '#6b7280'
    const cePct =
      this.settings.showPercent && this.totalCeOi > 0
        ? `${((hit.ceOi / this.totalCeOi) * 100).toFixed(1)}% of Call OI`
        : ''
    const pePct =
      this.settings.showPercent && this.totalPeOi > 0
        ? `${((hit.peOi / this.totalPeOi) * 100).toFixed(1)}% of Put OI`
        : ''

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)'};">
        <span style="font-weight:600;letter-spacing:0.01em;">${this.resolvedUnderlying} ${hit.strike}</span>
        <span style="font-size:11px;color:${muted};">${formatExpiryLabel(this.resolvedExpiry)}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:11px;color:${muted};margin-bottom:2px;">Call OI</div>
          <div style="font-weight:600;font-size:13px;">${formatIndianOI(hit.ceOi)}</div>
          ${cePct ? `<div style="font-size:10px;color:${this.settings.callColor};margin-top:2px;">${cePct}</div>` : ''}
          <div style="height:3px;border-radius:2px;margin-top:4px;background:${this.settings.callColor};"></div>
        </div>
        <div>
          <div style="font-size:11px;color:${muted};margin-bottom:2px;">Put OI</div>
          <div style="font-weight:600;font-size:13px;">${formatIndianOI(hit.peOi)}</div>
          ${pePct ? `<div style="font-size:10px;color:${this.settings.putColor};margin-top:2px;">${pePct}</div>` : ''}
          <div style="height:3px;border-radius:2px;margin-top:4px;background:${this.settings.putColor};"></div>
        </div>
      </div>
    `
    el.style.display = 'block'

    const cw = this.opts.container.clientWidth
    const ch = this.opts.container.clientHeight
    const tw = el.offsetWidth || 220
    const th = el.offsetHeight || 96
    const left = clamp(localX - tw - 16, 8, Math.max(8, cw - tw - 8))
    const top = clamp(localY - th / 2, 8, Math.max(8, ch - th - 8))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }

  private hideTooltip(): void {
    this.hoveredStrike = null
    this.primitive?.setHoveredStrike(null)
    if (this.tooltipEl) this.tooltipEl.style.display = 'none'
  }

  detachPrimitive(): void {
    if (this.primitive && this.attachedChart) {
      try {
        this.attachedChart.removePrimitive(this.primitive)
      } catch {
        /* chart already destroyed */
      }
    }
    this.primitive = null
    this.attachedChart = null
  }

  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.stopTimer()
    this.opts.container.removeEventListener('pointermove', this.onPointerMove)
    this.opts.container.removeEventListener('pointerleave', this.onPointerLeave)
    this.hideTooltip()
    this.tooltipEl?.remove()
    this.tooltipEl = null
    this.detachPrimitive()
  }
}
