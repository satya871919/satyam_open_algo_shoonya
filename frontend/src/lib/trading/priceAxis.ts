/**
 * The price scale as a trader drives it: its right-click menu, its keyboard
 * chords, and the price levels drawn against it.
 *
 * Everything a trader chooses here is kept in the pane's chart settings, the
 * same flat record the Chart settings dialog writes, so a theme or chart type
 * rebuild, a reload and a saved workspace all bring it back without a store of
 * their own. Four of those choices are the engine's own settings keys
 * (`scales.mode`, `scales.inverted`, `scales.autoScale`, `scales.priceOnly`)
 * and the last price is the series' own pair (`symbol.priceLineVisible`,
 * `symbol.lastValueVisible`). The rest are this host's, listed in
 * `PRICE_AXIS_DEFAULTS`, and never reach the engine's settings call.
 *
 * A level with nothing behind it draws nothing. Previous close needs a session
 * before the one in view, bid and ask need a live order book, and the engine
 * returns null rather than a guess for each, so a level that cannot be drawn
 * correctly is not drawn at all and its menu row says "no data".
 *
 * Bid and ask come from the depth the terminal already subscribes to. Nothing
 * here asks the server for anything. The quote is one object mutated in place
 * and read by the engine when it paints, so a tick allocates nothing here.
 */
import {
  type Bar,
  type CustomShortcut,
  computePriceLevels,
  type createChart,
  lastPriceLevelFromSeriesStyle,
  PRICE_LEVEL_KINDS,
  PRICE_SCALE_MODES,
  type PriceLevelKind,
  type PriceLevelStyle,
  PriceLevels,
  type PriceLevelsOptions,
  type PriceScaleMode,
  readChartSettings,
  seriesStyleForLastPriceLevel,
  sessionStartFlags,
} from 'openalgo-charts'
import type { ChartSettingsField, ChartSettingsRequest } from './terminal'

type Chart = ReturnType<typeof createChart>
type Values = Record<string, string | number | boolean>

/** Engine-native levels handled by `PriceLevels`. */
const ENGINE_LEVELS = ['previousClose', 'sessionHigh', 'sessionLow', 'bid', 'ask'] as const
type EngineLevel = (typeof ENGINE_LEVELS)[number]

/** The levels this host draws itself. The last price is the series' own line. */
export const HOST_LEVELS = [
  'previousClose',
  'sessionHigh',
  'sessionLow',
  'todayOpen',
  'preDayOpen',
  'bid',
  'ask',
] as const
export type HostLevel = (typeof HOST_LEVELS)[number]
/** Every level the menu lists, in the order it lists them. */
export type MenuLevel = HostLevel | 'lastPrice'
const MENU_LEVELS: readonly MenuLevel[] = [
  'lastPrice',
  'previousClose',
  'sessionHigh',
  'sessionLow',
  'todayOpen',
  'preDayOpen',
  'bid',
  'ask',
]

export const LEVEL_LABELS: Record<MenuLevel, string> = {
  lastPrice: 'Last price',
  previousClose: 'Previous close',
  sessionHigh: 'Day high',
  sessionLow: 'Day low',
  todayOpen: 'Today open',
  preDayOpen: 'Pre day open',
  bid: 'Bid',
  ask: 'Ask',
}

/** How one level shows: its line across the plot, its tag on the axis, both or neither. */
export type LevelShow = 'off' | 'line' | 'tag' | 'both'
const SHOWS: readonly LevelShow[] = ['off', 'line', 'tag', 'both']

export const levelKey = (kind: HostLevel): string => `levels.${kind}`
export const AXIS_SIDE_KEY = 'priceAxis.side'

/**
 * This host's keys and what they are on a chart nobody has touched. Every new
 * level is off, so a pane saved before these existed opens exactly as it did.
 */
export const PRICE_AXIS_DEFAULTS: Values = {
  ...Object.fromEntries(HOST_LEVELS.map((kind) => [levelKey(kind), 'off'])),
  [AXIS_SIDE_KEY]: 'right',
}

/** A key this module owns: kept with the pane's settings, never handed to the engine. */
export function isPriceAxisSetting(key: string): boolean {
  return key in PRICE_AXIS_DEFAULTS
}

/** A saved level, read defensively: anything unrecognised is off. */
export function levelShow(saved: Values, kind: HostLevel): LevelShow {
  const value = saved[levelKey(kind)]
  return SHOWS.includes(value as LevelShow) ? (value as LevelShow) : 'off'
}

export function showOf(line: boolean, tag: boolean): LevelShow {
  return line ? (tag ? 'both' : 'line') : tag ? 'tag' : 'off'
}

function halves(show: LevelShow): Pick<PriceLevelStyle, 'line' | 'label'> {
  return { line: show === 'line' || show === 'both', label: show === 'tag' || show === 'both' }
}

/** The saved side, read defensively: anything but left is the right. */
export function axisSide(saved: Values): 'left' | 'right' {
  return saved[AXIS_SIDE_KEY] === 'left' ? 'left' : 'right'
}

/** The four modes as one choice, in the engine's order, with this host's words. */
export const SCALE_MODES: readonly { value: PriceScaleMode; label: string; chord?: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'logarithmic', label: 'Logarithmic', chord: 'Alt+L' },
  { value: 'percentage', label: 'Percent', chord: 'Alt+P' },
  { value: 'indexed-to-100', label: 'Indexed to 100', chord: 'Alt+1' },
].filter((mode) => PRICE_SCALE_MODES.includes(mode.value as PriceScaleMode)) as {
  value: PriceScaleMode
  label: string
  chord?: string
}[]

export type PriceAxisCommand =
  | { type: 'autoFit' }
  | { type: 'priceOnly' }
  | { type: 'invert' }
  | { type: 'reset' }
  | { type: 'mode'; mode: PriceScaleMode }
  /** Toggle a mode from the keyboard: pressed again, it goes back to linear. */
  | { type: 'toggleMode'; mode: PriceScaleMode }
  | { type: 'side'; side: 'left' | 'right' }
  | { type: 'level'; kind: MenuLevel; half: 'line' | 'tag'; on: boolean }

/** The price scale as its menu shows it, read when the menu opens. */
export interface PriceAxisMenu {
  autoFit: boolean
  priceOnly: boolean
  inverted: boolean
  mode: PriceScaleMode
  side: 'left' | 'right'
  levels: { kind: MenuLevel; label: string; line: boolean; tag: boolean; available: boolean }[]
}

/** Keyboard chords, shown on the menu rows and bound on every chart. */
export const AXIS_CHORDS = {
  autoFit: 'Alt+A',
  invert: 'Alt+I',
  reset: 'Alt+R',
} as const

/**
 * The patch a command means, as chart settings keys, read against the chart as
 * it is now. Null when there is nothing to change.
 */
export function priceAxisPatch(
  command: PriceAxisCommand,
  chart: Chart,
  saved: Values
): Values | null {
  const now = readChartSettings(chart)
  switch (command.type) {
    case 'autoFit':
      return { 'scales.autoScale': now['scales.autoScale'] !== true }
    case 'priceOnly':
      return { 'scales.priceOnly': now['scales.priceOnly'] !== true }
    case 'invert':
      return { 'scales.inverted': now['scales.inverted'] !== true }
    case 'reset':
      // Back to what a fresh chart shows: a linear ladder, the right way up,
      // fitted to the data.
      return { 'scales.mode': 'linear', 'scales.inverted': false, 'scales.autoScale': true }
    case 'mode':
      return { 'scales.mode': command.mode }
    case 'toggleMode':
      return { 'scales.mode': now['scales.mode'] === command.mode ? 'linear' : command.mode }
    case 'side':
      return { [AXIS_SIDE_KEY]: command.side }
    case 'level': {
      if (command.kind === 'lastPrice') {
        const current = lastPriceLevelFromSeriesStyle({
          priceLineVisible: now['symbol.priceLineVisible'] !== false,
          lastValueVisible: now['symbol.lastValueVisible'] !== false,
        })
        const next = { ...current, [command.half === 'line' ? 'line' : 'label']: command.on }
        const style = seriesStyleForLastPriceLevel(next)
        return {
          'symbol.priceLineVisible': style.priceLineVisible !== false,
          'symbol.lastValueVisible': style.lastValueVisible !== false,
        }
      }
      return levelPatch(saved, command.kind, command.half, command.on)
    }
  }
}

/** The patch for one of this host's levels, which needs the saved settings rather than the chart. */
export function levelPatch(
  saved: Values,
  kind: HostLevel,
  half: 'line' | 'tag',
  on: boolean
): Values {
  const now = halves(levelShow(saved, kind))
  const line = half === 'line' ? on : now.line
  const tag = half === 'tag' ? on : now.label
  return { [levelKey(kind)]: showOf(line, tag) }
}

/** Whether focus or an open surface owns the keyboard, so a chart chord must not fire. */
export function keyboardOwnedElsewhere(doc: Document): boolean {
  const active = doc.activeElement
  if (
    active?.closest?.(
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="textbox"], [role="menu"]'
    )
  )
    return true
  return (
    doc.querySelector(
      '[data-trading-dialog-open="true"], [role="dialog"][data-state="open"], [aria-modal="true"]'
    ) !== null
  )
}

/**
 * The price scale chords, as custom shortcuts on the chart's own shortcut
 * manager. It answers only for the chart under the pointer and already ignores
 * a keystroke typed into a field, so in a grid the chord reaches the pane being
 * looked at. The dialog check covers the rest: the order ticket and every
 * settings form keep the keyboard while they are open.
 *
 * Bound by key position (`KeyA`, `Digit1`), so a layout that types a different
 * character on Alt still reaches the same chord.
 */
export function priceAxisShortcuts(
  run: (command: PriceAxisCommand) => void,
  doc: Document = document
): CustomShortcut[] {
  const bind = (command: string, label: string, combos: string, cmd: PriceAxisCommand) => ({
    command: `app:priceScale:${command}`,
    label,
    combos,
    onTrigger: () => {
      if (!keyboardOwnedElsewhere(doc)) run(cmd)
    },
  })
  return [
    bind('autoFit', 'Auto-fit the price scale', 'Alt+KeyA', { type: 'autoFit' }),
    bind('invert', 'Invert the price scale', 'Alt+KeyI', { type: 'invert' }),
    bind('reset', 'Reset the price scale', 'Alt+KeyR', { type: 'reset' }),
    bind('log', 'Logarithmic price scale', 'Alt+KeyL', {
      type: 'toggleMode',
      mode: 'logarithmic',
    }),
    bind('percent', 'Percent price scale', 'Alt+KeyP', { type: 'toggleMode', mode: 'percentage' }),
    bind('indexed', 'Price scale indexed to 100', 'Alt+Digit1', {
      type: 'toggleMode',
      mode: 'indexed-to-100',
    }),
  ]
}

/** Style for every engine level: this host's from the settings, every other one off. */
function levelOptions(saved: Values): Record<PriceLevelKind, Partial<PriceLevelStyle>> {
  const levels = {} as Record<PriceLevelKind, Partial<PriceLevelStyle>>
  for (const kind of PRICE_LEVEL_KINDS) levels[kind] = { line: false, label: false }
  const colors: Partial<Record<EngineLevel, string>> = {
    sessionHigh: '#2962ff',
    sessionLow: '#2962ff',
    previousClose: '#525866',
  }
  for (const kind of ENGINE_LEVELS) {
    const c = colors[kind]
    levels[kind] = c ? { ...halves(levelShow(saved, kind)), color: c } : halves(levelShow(saved, kind))
  }
  return levels
}

const sessionStartsCache = new WeakMap<
  readonly Bar[],
  { len: number; first: number; last: number; tz: string; starts: number[] }
>()

function getSessionStarts(bars: readonly Bar[], timezone: string): number[] {
  if (bars.length === 0) return []
  const first = bars[0].time
  const last = bars[bars.length - 1].time
  const cached = sessionStartsCache.get(bars)
  if (
    cached &&
    cached.len === bars.length &&
    cached.first === first &&
    cached.last === last &&
    cached.tz === timezone
  ) {
    return cached.starts
  }
  const times = new Array<number>(bars.length)
  for (let i = 0; i < bars.length; i++) times[i] = bars[i].time
  const flags = sessionStartFlags(times, timezone)
  const starts = [0]
  for (let i = 1; i < bars.length; i++) if (flags[i]) starts.push(i)
  sessionStartsCache.set(bars, { len: bars.length, first, last, tz: timezone, starts })
  return starts
}

function computeOpenLevels(
  bars: readonly Bar[],
  anchorTime: number | undefined,
  timezone: string
): { todayOpen: number | null; preDayOpen: number | null } {
  if (bars.length === 0) return { todayOpen: null, preDayOpen: null }
  const starts = getSessionStarts(bars, timezone)
  let anchorIdx = bars.length - 1
  if (anchorTime !== undefined && Number.isFinite(anchorTime)) {
    if (anchorTime < bars[0].time) anchorIdx = -1
    else if (anchorTime < bars[bars.length - 1].time) {
      let lo = 0
      let hi = bars.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (bars[mid].time <= anchorTime) lo = mid
        else hi = mid - 1
      }
      anchorIdx = lo
    }
  }
  if (anchorIdx < 0 || starts.length === 0) return { todayOpen: null, preDayOpen: null }
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= anchorIdx) lo = mid
    else hi = mid - 1
  }
  const to = bars[starts[lo]]?.open
  const po = lo > 0 ? bars[starts[lo - 1]]?.open : undefined
  return {
    todayOpen: typeof to === 'number' && Number.isFinite(to) ? to : null,
    preDayOpen: typeof po === 'number' && Number.isFinite(po) ? po : null,
  }
}

/**
 * Auto-fit off, as a saved setting brings it back. Pinning the scale before
 * anything has been measured pins it at the engine's placeholder range, which
 * is a blank chart, so the pin waits for the first frame that has fitted the
 * data and holds that range. Gives up quietly if the chart goes first.
 */
export function pinOnceMeasured(
  chart: Pick<Chart, 'priceAxisState' | 'primaryPaneIndex' | 'setAutoScale'>,
  alive: () => boolean,
  frame: (cb: () => void) => unknown = requestAnimationFrame,
  tries = 120
): void {
  const attempt = (left: number) => {
    if (!alive()) return
    if (chart.priceAxisState(chart.primaryPaneIndex(), 'right')?.scaled) chart.setAutoScale(false)
    else if (left > 0) frame(() => attempt(left - 1))
  }
  attempt(tries)
}

/** An empty patch: asks the levels to repaint, changing nothing, allocating nothing. */
const REPAINT: PriceLevelsOptions = Object.freeze({})

/**
 * The levels and the axis side on one chart. One per terminal, re-pointed at
 * every chart it builds: a rebuild destroys the old chart and its primitives
 * with it, so the next `sync` starts afresh.
 */
/**
 * Extends `PriceLevels` so the chart only needs a single primitive for both
 * engine-native levels (`High`, `Low`, `Pre Close`, `Bid`, `Ask`) and host
 * session-open levels (`Today Open`, `Pre Day Open`) plus their axis-side tags.
 */
class HostPriceLevels extends PriceLevels {
  private saved: Values = {}
  private tz = 'Asia/Kolkata'

  setHostState(saved: Values, tz: string): void {
    this.saved = saved
    this.tz = tz
  }

  override draw(ctx: CanvasRenderingContext2D, rc: Parameters<PriceLevels['draw']>[1]): void {
    super.draw(ctx, rc)
    if (rc.priceAxisSide === 'hidden' || rc.priceAxisWidth <= 0) return

    const badgeLevels: readonly HostLevel[] = [
      'previousClose',
      'sessionHigh',
      'sessionLow',
      'todayOpen',
      'preDayOpen',
    ]
    if (!badgeLevels.some((k) => levelShow(this.saved, k) !== 'off')) return

    const dpr = rc.dpr || 1
    const plotW = Math.round(rc.plotWidth * dpr)
    const plotH = rc.plotHeight * dpr
    const axisW = Math.round(rc.priceAxisWidth * dpr)
    const bars = rc.bars?.() ?? []
    let anchorTime: number | undefined
    try {
      anchorTime = rc.dataLayer.indexToTimeFloat(rc.timeScale.visibleRange().to)
    } catch {
      anchorTime = undefined
    }
    const engineVals = this.values()
    const openVals =
      levelShow(this.saved, 'todayOpen') !== 'off' ||
      levelShow(this.saved, 'preDayOpen') !== 'off'
        ? computeOpenLevels(bars, anchorTime, this.tz)
        : { todayOpen: null, preDayOpen: null }

    const items: Array<{
      kind: HostLevel
      val: number | null | undefined
      label: string
      bg: string
      customDraw: boolean
    }> = [
      { kind: 'sessionHigh', val: engineVals.sessionHigh, label: 'High', bg: '#2962ff', customDraw: false },
      { kind: 'sessionLow', val: engineVals.sessionLow, label: 'Low', bg: '#2962ff', customDraw: false },
      { kind: 'previousClose', val: engineVals.previousClose, label: 'Pre Close', bg: '#525866', customDraw: false },
      { kind: 'todayOpen', val: openVals.todayOpen, label: 'Today Open', bg: '#089981', customDraw: true },
      { kind: 'preDayOpen', val: openVals.preDayOpen, label: 'Pre Day Open', bg: '#8b5cf6', customDraw: true },
    ]

    ctx.save()
    ctx.font = `600 ${Math.round(10 * dpr)}px system-ui, sans-serif`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    const padX = 5 * dpr
    const boxH = 16 * dpr
    const radius = 3 * dpr
    const rightEdge = plotW - 4 * dpr

    for (const item of items) {
      const h = halves(levelShow(this.saved, item.kind))
      if (!h.line && !h.label) continue
      if (item.val == null) continue
      const y = Math.round(rc.priceScale.priceToY(item.val) * dpr)
      if (!Number.isFinite(y) || y < 0 || y > plotH) continue

      if (item.customDraw && h.line) {
        const lineY = y + 0.5
        ctx.strokeStyle = item.bg
        ctx.lineWidth = Math.max(1, Math.round(dpr))
        ctx.setLineDash([4 * dpr, 4 * dpr])
        ctx.beginPath()
        ctx.moveTo(0, lineY)
        ctx.lineTo(plotW, lineY)
        ctx.stroke()
        ctx.setLineDash([])
      }

      if (h.label) {
        if (item.customDraw && rc.priceAxisSide !== 'left' && axisW > 0) {
          const axisTop = Math.round(y - (18 * dpr) / 2)
          const axisH = Math.round(18 * dpr)
          ctx.fillStyle = item.bg
          ctx.fillRect(plotW, axisTop, axisW, axisH)
          ctx.fillStyle = '#ffffff'
          ctx.fillText(rc.priceScale.format(item.val), plotW + axisW / 2, y + 0.5 * dpr)
        }
        const textW = ctx.measureText(item.label).width
        const boxW = Math.round(textW + padX * 2)
        const x = Math.round(rightEdge - boxW)
        const top = Math.round(y - boxH / 2)
        ctx.fillStyle = item.bg
        ctx.beginPath()
        ctx.roundRect(x, top, boxW, boxH, radius)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillText(item.label, x + boxW / 2, y + 0.5 * dpr)
      }
    }
    ctx.restore()
  }
}

/**
 * The levels and the axis side on one chart. One per terminal, re-pointed at
 * every chart it builds: a rebuild destroys the old chart and its primitives
 * with it, so the next `sync` starts afresh.
 */
export class PriceAxisController {
  private chart: Chart | null = null
  private levels: HostPriceLevels | null = null
  /** Mutated in place by the depth stream; the engine reads it when it paints. */
  private readonly quote: { bid: number | null; ask: number | null } = { bid: null, ask: null }
  /**
   * The book as the chart may draw it: none while the chart shows something
   * other than the live market, such as a replayed session, where today's bid
   * and ask would be lines at prices that did not exist then.
   */
  private readonly drawnQuote = () => (this.live() ? this.quote : null)

  private readonly live: () => boolean

  /** `live` answers whether the chart is showing the live market right now. */
  constructor(live: () => boolean = () => true) {
    this.live = live
  }

  /**
   * Bring the chart in line with the saved settings. Idempotent, and cheap
   * when nothing changed. The level primitive is attached only while some level
   * is on, so a chart with them all off pays nothing per frame.
   */
  sync(chart: Chart, saved: Values): void {
    if (chart !== this.chart) {
      this.chart = chart
      this.levels = null
    }
    const options = levelOptions(saved)
    const wanted = HOST_LEVELS.some((kind) => levelShow(saved, kind) !== 'off')
    const tz = chart.timezone()
    if (!wanted) {
      if (this.levels) chart.removePrimitive(this.levels)
      this.levels = null
    } else if (this.levels) {
      this.levels.setHostState(saved, tz)
      this.levels.setOptions({ levels: options, timezone: tz })
    } else {
      this.levels = new HostPriceLevels({
        levels: options,
        timezone: tz,
        quote: this.drawnQuote,
      })
      this.levels.setHostState(saved, tz)
      chart.addPrimitive(this.levels)
    }

    const pane = chart.primaryPaneIndex()
    const side = axisSide(saved)
    const placement = chart.priceAxisPlacement(pane, 'right')
    if (placement && placement.side !== 'hidden' && placement.side !== side)
      chart.setPriceAxisPlacement(pane, 'right', side)
  }

  /** Forget the chart, which is being destroyed. */
  detach(): void {
    this.chart = null
    this.levels = null
  }

  /**
   * The best bid and ask, or null for a side the book does not quote. Repaints
   * only when a value the chart draws actually moved.
   */
  setQuote(bid: unknown, ask: unknown): void {
    const b = typeof bid === 'number' && Number.isFinite(bid) && bid > 0 ? bid : null
    const a = typeof ask === 'number' && Number.isFinite(ask) && ask > 0 ? ask : null
    if (b === this.quote.bid && a === this.quote.ask) return
    this.quote.bid = b
    this.quote.ask = a
    // The same callback again: nothing is allocated, the engine just repaints.
    this.levels?.setOptions(REPAINT)
  }

  /** The menu as it should read right now. */
  menu(chart: Chart, saved: Values): PriceAxisMenu {
    const now = readChartSettings(chart)
    const bars = chart.primaryBars()
    // The session in view, the way the levels themselves anchor: the bar at
    // the right edge of the viewport.
    let anchorTime: number | undefined
    try {
      anchorTime = chart.dataLayer.indexToTimeFloat(chart.timeScale.visibleRange().to)
    } catch {
      anchorTime = undefined
    }
    const values = computePriceLevels({
      bars,
      anchorTime: Number.isFinite(anchorTime) ? anchorTime : undefined,
      timezone: chart.timezone(),
      quote: this.drawnQuote(),
    })
    const openValues = computeOpenLevels(
      bars,
      Number.isFinite(anchorTime) ? anchorTime : undefined,
      chart.timezone()
    )
    const last = lastPriceLevelFromSeriesStyle({
      priceLineVisible: now['symbol.priceLineVisible'] !== false,
      lastValueVisible: now['symbol.lastValueVisible'] !== false,
    })
    const mode = now['scales.mode']
    return {
      autoFit: now['scales.autoScale'] !== false,
      priceOnly: now['scales.priceOnly'] === true,
      inverted: now['scales.inverted'] === true,
      mode: PRICE_SCALE_MODES.includes(mode as PriceScaleMode)
        ? (mode as PriceScaleMode)
        : 'linear',
      side: axisSide(saved),
      levels: MENU_LEVELS.map((kind) => {
        const shown =
          kind === 'lastPrice'
            ? { line: last.line, tag: last.label }
            : (() => {
                const h = halves(levelShow(saved, kind))
                return { line: h.line, tag: h.label }
              })()
        const available =
          kind === 'lastPrice'
            ? bars.length > 0
            : kind === 'todayOpen'
              ? openValues.todayOpen !== null
              : kind === 'preDayOpen'
                ? openValues.preDayOpen !== null
                : values[kind] !== null
        return {
          kind,
          label: LEVEL_LABELS[kind],
          ...shown,
          available,
        }
      }),
    }
  }
}

const SHOW_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'both', label: 'Line and tag' },
  { value: 'line', label: 'Line only' },
  { value: 'tag', label: 'Tag only' },
]

const settingsFields: ChartSettingsField[] = [
  {
    key: AXIS_SIDE_KEY,
    type: 'select',
    label: 'Scale position',
    group: 'Price scale',
    options: [
      { value: 'right', label: 'Right' },
      { value: 'left', label: 'Left' },
    ],
  },
  ...HOST_LEVELS.map(
    (kind): ChartSettingsField => ({
      key: levelKey(kind),
      type: 'select',
      label: LEVEL_LABELS[kind],
      group: 'Price levels',
      options: SHOW_OPTIONS,
      ...(kind === 'bid' || kind === 'ask'
        ? { tooltip: 'Drawn from the live order book. Index charts have none.' }
        : {}),
    })
  ),
]

/** The saved host values, each read defensively, for the dialog to show. */
export function priceAxisValues(saved: Values): Values {
  return {
    [AXIS_SIDE_KEY]: axisSide(saved),
    ...Object.fromEntries(HOST_LEVELS.map((kind) => [levelKey(kind), levelShow(saved, kind)])),
  }
}

/** Add the scale position and the levels to the Axes tab of the settings dialog. */
export function priceAxisSettingsView(
  view: ChartSettingsRequest,
  saved: Values
): ChartSettingsRequest {
  const hasAxes = view.tabs.some((tab) => tab.id === 'axes')
  const tabs = hasAxes
    ? view.tabs.map((tab) =>
        tab.id === 'axes' ? { ...tab, inputs: [...tab.inputs, ...settingsFields] } : tab
      )
    : [...view.tabs, { id: 'axes', label: 'Axes', inputs: settingsFields }]
  return {
    ...view,
    tabs,
    values: { ...view.values, ...priceAxisValues(saved) },
    defaults: { ...view.defaults, ...PRICE_AXIS_DEFAULTS },
  }
}
