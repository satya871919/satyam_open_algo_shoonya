/**
 * Quick entry on a chart: type a letter for the symbol search, a digit for the
 * interval box. See `lib/trading/quickEntry.ts` for which keys count.
 */
import { useEffect, useId, useRef, useState } from 'react'
import {
  parseQuickInterval,
  type QuickEntryKind,
  quickEntryKind,
  SEARCH_INPUT_ATTR,
} from '@/lib/trading/quickEntry'

interface QuickEntryOptions {
  /** Whether this chart owns typed keys right now: selected, built and with nothing open. */
  enabled: boolean
  onStart(kind: QuickEntryKind, text: string): void
}

/**
 * Listen for a key that starts quick entry on this chart.
 *
 * Bubble phase on the window, so anything nearer the key that claims it first
 * (a dialog, a field, the chart's own shortcuts) has already said so by
 * calling `preventDefault`, which `quickEntryKind` honours.
 */
export function useQuickEntry({ enabled, onStart }: QuickEntryOptions): void {
  const start = useRef(onStart)
  start.current = onStart
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const kind = quickEntryKind(e)
      if (!kind) return
      e.preventDefault()
      start.current(kind, e.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

/**
 * Keep keys typed while the symbol search is still opening.
 *
 * The search is fetched on demand and its box takes focus a moment after it
 * appears. A trader typing RELIANCE straight off the chart would otherwise lose
 * every letter between the R and the box being ready. While `active`, those
 * keys are added to the seed instead, and the box picks the seed up as its
 * starting text. The moment the box has focus, keys go to it as normal and
 * `onSettled` says the seed is final, so nothing typed later can replace what
 * is in the box.
 */
export function useSeedBuffer(
  active: boolean,
  onType: (update: (seed: string) => string) => void,
  onSettled: () => void
) {
  const type = useRef(onType)
  type.current = onType
  const settled = useRef(onSettled)
  settled.current = onSettled
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const focused = document.activeElement
      if (focused?.hasAttribute?.(SEARCH_INPUT_ATTR)) {
        settled.current()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      if (e.key === 'Backspace') {
        e.preventDefault()
        type.current((seed) => seed.slice(0, -1))
      } else if (e.key.length === 1) {
        e.preventDefault()
        type.current((seed) => seed + e.key)
      }
    }
    const onFocus = (e: FocusEvent) => {
      if ((e.target as Element | null)?.hasAttribute?.(SEARCH_INPUT_ATTR)) settled.current()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    document.addEventListener('focusin', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      document.removeEventListener('focusin', onFocus)
    }
  }, [active])
}

interface IntervalBoxProps {
  /** What the trader typed to open it. */
  initial: string
  /** The broker's intervals, the only ones accepted. */
  available: readonly string[]
  canSelectInterval?: (code: string) => boolean
  onApply(code: string): void
  onClose(): void
}

/**
 * The interval box a digit opens. Enter applies, Escape or a click away closes.
 *
 * Drawn over the chart, never beside it, so it costs the plot nothing: it is
 * there for the two seconds it takes to type `15` and press Enter.
 */
function formatIntervalPreview(
  text: string,
  available: readonly string[],
  canSelectInterval?: (code: string) => boolean
): string {
  const result = parseQuickInterval(text, available, canSelectInterval)
  const code = result.code
  if (!code) return '5 is 5 minutes, or type 1h, D, W'
  const m = /^(\d+)([smhdw])$/i.exec(code)
  if (m) {
    const n = Number(m[1])
    const unitMap: Record<string, string> = {
      s: n === 1 ? 'second' : 'seconds',
      m: n === 1 ? 'minute' : 'minutes',
      h: n === 1 ? 'hour' : 'hours',
      d: n === 1 ? 'day' : 'days',
      w: n === 1 ? 'week' : 'weeks',
    }
    return `${n} ${unitMap[m[2].toLowerCase()] ?? m[2]}`
  }
  if (code === 'D' || code === '1D') return '1 day'
  if (code === 'W' || code === '1W') return '1 week'
  if (code === 'M' || code === '1M') return '1 month'
  return code
}

export function QuickIntervalBox({
  initial,
  available,
  canSelectInterval,
  onApply,
  onClose,
}: IntervalBoxProps) {
  const id = useId()
  const [text, setText] = useState(initial)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const node = input.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])
  const preview = formatIntervalPreview(text, available, canSelectInterval)
  return (
    <div
      role="dialog"
      aria-label="Change interval"
      className="pointer-events-auto absolute left-1/2 top-1/3 z-40 flex w-64 max-w-[calc(100%-24px)] -translate-x-1/2 flex-col items-center rounded-xl border border-border/80 bg-popover px-6 py-5 shadow-2xl"
    >
      <div className="mb-3.5 flex items-center gap-1.5">
        <span className="text-base font-semibold tracking-tight text-foreground">
          Change interval
        </span>
        <span
          title="Enter to apply: 5 is 5 minutes, or type 1h, D, W"
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/50 text-[10px] font-medium text-muted-foreground"
        >
          i
        </span>
      </div>
      <label htmlFor={id} className="sr-only">
        Interval
      </label>
      <input
        ref={input}
        id={id}
        value={text}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setText(e.target.value)
          setError('')
        }}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
            return
          }
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          const result = parseQuickInterval(text, available, canSelectInterval)
          if (result.code === undefined) setError(result.error)
          else onApply(result.code)
        }}
        className="h-10 w-44 rounded-lg border-2 border-[#2962ff] bg-background/60 px-3 text-center text-base font-medium tabular-nums text-foreground outline-none transition-colors focus:border-[#2962ff]"
      />
      <p
        id={`${id}-hint`}
        role={error ? 'alert' : undefined}
        className={
          error
            ? 'mt-2 text-center text-xs text-destructive'
            : 'mt-2 text-center text-xs text-muted-foreground'
        }
      >
        {error || preview}
      </p>
    </div>
  )
}
