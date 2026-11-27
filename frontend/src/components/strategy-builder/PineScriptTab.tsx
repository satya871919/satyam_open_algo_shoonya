import { AlertTriangle, Check, Code2, ExternalLink, Loader2, RefreshCw, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import type { StrategyLeg } from '@/lib/strategyMath'
import {
  type CompileResult,
  compileSource,
  fileNameFor,
  nameProblem,
  saveScript,
} from '@/lib/trading/pinescriptFiles'
import { type HighlightedSpan, highlight, SPAN_CLASS } from '@/lib/trading/pinescriptHighlight'
import { cn } from '@/lib/utils'
import { showToast } from '@/utils/toast'

interface PineScriptTabProps {
  underlying: string
  exchange: string
  expiry: string
  legs: StrategyLeg[]
}

function buildPineFromStrategy(
  underlying: string,
  exchange: string,
  expiry: string,
  legs: StrategyLeg[]
): string {
  const activeLegs = legs.filter((l) => l.active)
  const title = `${underlying || 'Strategy'}${expiry ? ` ${expiry}` : ''}`.trim()
  const totalLots = activeLegs.reduce((sum, l) => sum + Math.max(1, l.lots || 1), 0) || 1
  const hasShort = activeLegs.some((l) => l.side === 'SELL')
  const legLines =
    activeLegs.length > 0
      ? activeLegs.map(
          (l, idx) =>
            `// Leg ${idx + 1}: ${l.side} ${l.lots}x ${l.strike ?? ''} ${l.optionType ?? l.segment} (${l.expiry || expiry})`
        )
      : ['// No legs selected yet — using default EMA crossover template']

  return [
    '//@version=6',
    `strategy("${title}", overlay=true, default_qty_value=${totalLots})`,
    `// Underlying: ${underlying || 'NIFTY'} (${exchange || 'NFO'})`,
    ...legLines,
    '',
    'fastLen = input.int(9, "Fast EMA", minval=1)',
    'slowLen = input.int(21, "Slow EMA", minval=1)',
    'fast = ta.ema(close, fastLen)',
    'slow = ta.ema(close, slowLen)',
    '',
    'plot(fast, "Fast EMA", color=color.aqua)',
    'plot(slow, "Slow EMA", color=color.orange)',
    '',
    'if ta.crossover(fast, slow)',
    hasShort
      ? '    strategy.entry("SELL_LEG", strategy.short)'
      : '    strategy.entry("BUY_LEG", strategy.long)',
    'if ta.crossunder(fast, slow)',
    hasShort ? '    strategy.close("SELL_LEG")' : '    strategy.close("BUY_LEG")',
    '',
  ].join('\n')
}

function defaultScriptSlug(underlying: string): string {
  const clean = (underlying || 'strategy')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${clean || 'strategy'}-pine`
}

export function PineScriptTab({ underlying, exchange, expiry, legs }: PineScriptTabProps) {
  const navigate = useNavigate()
  const [scriptName, setScriptName] = useState(() => defaultScriptSlug(underlying))
  const [source, setSource] = useState(() =>
    buildPineFromStrategy(underlying, exchange, expiry, legs)
  )
  const [edited, setEdited] = useState(false)
  const [spans, setSpans] = useState<HighlightedSpan[]>([])
  const [result, setResult] = useState<CompileResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [scrolled, setScrolled] = useState({ top: 0, left: 0 })
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // Keep generated code synced with Builder legs until the trader edits the code manually.
  useEffect(() => {
    if (edited) return
    setSource(buildPineFromStrategy(underlying, exchange, expiry, legs))
  }, [edited, underlying, exchange, expiry, legs])

  useEffect(() => {
    let stale = false
    void highlight(source).then((next) => {
      if (!stale) setSpans(next)
    })
    return () => {
      stale = true
    }
  }, [source])

  const compileCurrent = useCallback(async () => {
    const file = nameProblem(scriptName) === null ? fileNameFor(scriptName) : 'strategy.oscript'
    const compiled = await compileSource(file, source)
    setResult(compiled)
    return compiled
  }, [scriptName, source])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void compileCurrent().then((compiled) => {
        if (!cancelled) setResult(compiled)
      })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [compileCurrent])

  const handleRegenerate = () => {
    setSource(buildPineFromStrategy(underlying, exchange, expiry, legs))
    setEdited(false)
  }

  const handleSave = async () => {
    const nameErr = nameProblem(scriptName)
    if (nameErr) {
      showToast.error(nameErr)
      return
    }
    setBusy(true)
    try {
      const file = fileNameFor(scriptName)
      const compiled = await compileSource(file, source)
      setResult(compiled)
      await saveScript(file, source, compiled)
      if (compiled.ok) {
        showToast.success(`Saved ${file} (Pine Script compiled & ready)`)
      } else {
        showToast.error(`Saved ${file}, but Pine Script has errors`)
      }
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Could not save Pine Script')
    } finally {
      setBusy(false)
    }
  }

  const lines = useMemo(() => source.split('\n').length, [source])
  const errorCount = result?.diagnostics.filter((d) => d.severity === 'error').length ?? 0

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Pine Script v6 Strategy</h3>
            <p className="text-xs text-muted-foreground">
              Write or generate TradingView Pine Script and save it directly to your Trading terminal.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRegenerate}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Generate from Legs
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate('/trading')}
            className="h-8 gap-1.5 text-xs"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in Trading
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="sb-pine-name" className="text-xs font-medium text-muted-foreground">
          Script Name
        </label>
        <input
          id="sb-pine-name"
          type="text"
          value={scriptName}
          onChange={(e) => setScriptName(e.target.value)}
          placeholder="nifty-pine-strategy"
          className="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || nameProblem(scriptName) !== null}
          onClick={() => void handleSave()}
          className="h-8 gap-1.5 text-xs"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save Pine Script
        </Button>
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          {result?.ok ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Ready to backtest &amp; run
            </span>
          ) : result ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              {errorCount > 0
                ? `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`
                : result.problem || 'Compile error'}
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative flex h-[320px] overflow-hidden rounded-lg border bg-background">
        <div
          aria-hidden
          className="shrink-0 select-none overflow-hidden border-r bg-muted/30 py-2 pl-2 pr-2 text-right font-mono text-[12px] text-muted-foreground"
          style={{ lineHeight: '18px' }}
        >
          <div style={{ transform: `translateY(${-scrolled.top}px)` }}>
            {Array.from({ length: lines }, (_, index) => (
              <div
                key={index}
                className={cn(
                  result?.line === index + 1 && !result.ok && 'font-medium text-destructive'
                )}
              >
                {index + 1}
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <pre
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 min-w-full whitespace-pre px-2 py-2 font-mono text-[12px] tracking-normal"
            style={{
              lineHeight: '18px',
              transform: `translate(${-scrolled.left}px, ${-scrolled.top}px)`,
            }}
          >
            {spans.map((span, index) => (
              <span key={index} className={SPAN_CLASS[span.kind]}>
                {span.text}
              </span>
            ))}
          </pre>
          <textarea
            ref={areaRef}
            value={source}
            onChange={(e) => {
              setEdited(true)
              setSource(e.target.value.replace(/\r\n?/g, '\n'))
            }}
            onScroll={(e) =>
              setScrolled({
                top: e.currentTarget.scrollTop,
                left: e.currentTarget.scrollLeft,
              })
            }
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            wrap="off"
            aria-label="Pine Script strategy source"
            className="absolute inset-0 h-full w-full resize-none whitespace-pre bg-transparent px-2 py-2 font-mono text-[12px] tracking-normal text-transparent caret-foreground outline-none"
            style={{ lineHeight: '18px' }}
          />
        </div>
      </div>

      {result && (result.diagnostics.length > 0 || result.problem) && (
        <div className="max-h-32 space-y-1.5 overflow-auto rounded-lg border bg-muted/20 p-2.5 font-mono text-[11px]">
          {result.diagnostics.map((d) => (
            <div key={`${d.code}:${d.line}:${d.column}`} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'rounded px-1 py-px text-[10px] font-medium',
                    d.severity === 'error'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  )}
                >
                  {d.code}
                </span>
                <span className="text-muted-foreground">
                  line {d.line}, col {d.column}
                </span>
                <span className={d.severity === 'error' ? 'text-destructive' : 'text-amber-600'}>
                  {d.message}
                </span>
              </div>
              {d.fix && <span className="text-muted-foreground">Fix: {d.fix}</span>}
            </div>
          ))}
          {result.problem && result.diagnostics.length === 0 && (
            <p className="text-destructive">{result.problem}</p>
          )}
        </div>
      )}
    </div>
  )
}
