/**
 * The price scale's own right-click menu.
 *
 * Opened by a right-click on the price axis, where the chart menu with its
 * order rows used to open. Everything here acts on what the scale shows: how
 * it fits, which way up it reads, its mode, its side, and the levels tagged on
 * it. Every choice goes through the pane's chart settings, so it is kept.
 *
 * A level with no data is greyed and says so rather than being hidden: "no
 * previous session loaded" and "no order book" are information. One that is
 * already on can still be switched off, so a level turned on yesterday is never
 * stuck on a morning with no book yet.
 *
 * The level switches keep the menu open, since a trader usually sets more than
 * one; every other row closes it.
 */
import { Check, ChevronRight, RotateCcw, Settings } from 'lucide-react'
import { useState } from 'react'
import type { PriceAxisCommand, PriceAxisMenu } from '@/lib/trading/priceAxis'
import { AXIS_CHORDS, SCALE_MODES } from '@/lib/trading/priceAxis'
import { cn } from '@/lib/utils'

interface Props {
  menu: PriceAxisMenu
  x: number
  y: number
  /** Run a command. `keepOpen` is set for the level switches. */
  onCommand(command: PriceAxisCommand, keepOpen: boolean): void
  /** Open Chart settings on its Axes tab. */
  onSettings(): void
}

const row =
  'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-[13px] hover:bg-accent hover:text-accent-foreground'

function Chord({ text }: { text?: string }) {
  if (!text) return null
  return <span className="ml-auto pl-3 text-[11px] text-muted-foreground">{text}</span>
}

/** TradingView-style checkmark slot (fixed width so labels align cleanly). */
function CheckSlot({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      {on && <Check className="h-3.5 w-3.5 text-foreground" />}
    </span>
  )
}

const Separator = () => <div className="my-1 h-px bg-border" />

const MODE_LABELS: Record<string, string> = {
  linear: 'Regular',
  percentage: 'Percent',
  'indexed-to-100': 'Indexed to 100',
  logarithmic: 'Logarithmic',
}

export function PriceScaleMenu({ menu, x, y, onCommand, onSettings }: Props) {
  const [sub, setSub] = useState<'tag' | 'line' | null>(null)
  const run = (command: PriceAxisCommand) => onCommand(command, false)
  const toggle = (label: string, on: boolean, command: PriceAxisCommand, chord?: string) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      className={row}
      onMouseEnter={() => setSub(null)}
      onClick={() => run(command)}
    >
      <CheckSlot on={on} />
      <span>{label}</span>
      <Chord text={chord} />
    </button>
  )
  const other = menu.side === 'right' ? 'left' : 'right'
  const openLeft = typeof window !== 'undefined' && x > window.innerWidth / 2

  const orderedModes = [...SCALE_MODES].sort((a, b) => {
    const order = ['linear', 'percentage', 'indexed-to-100', 'logarithmic']
    return order.indexOf(a.value) - order.indexOf(b.value)
  })

  const renderSubmenu = (half: 'tag' | 'line') => (
    <div
      role="menu"
      aria-label={half === 'tag' ? 'Labels' : 'Lines'}
      className={cn(
        'absolute bottom-8 z-50 w-52 rounded-md border bg-popover p-1 shadow-xl',
        openLeft ? 'right-full mr-1' : 'left-full ml-1'
      )}
    >
      {menu.levels.map((level) => {
        const on = half === 'line' ? level.line : level.tag
        const disabled = !level.available && !on
        return (
          <button
            type="button"
            key={`${half}:${level.kind}`}
            role="menuitemcheckbox"
            aria-checked={on}
            aria-label={`${level.label} ${half === 'line' ? 'line' : 'axis tag'}`}
            disabled={disabled}
            title={disabled ? `No ${level.label.toLowerCase()} to show yet` : undefined}
            className={cn(
              row,
              disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-inherit'
            )}
            onClick={(e) => {
              e.stopPropagation()
              onCommand({ type: 'level', kind: level.kind, half, on: !on }, true)
            }}
          >
            <CheckSlot on={on} />
            <span className="min-w-0 flex-1 truncate">{level.label}</span>
            {!level.available && (
              <span className="text-[11px] text-muted-foreground">no data</span>
            )}
          </button>
        )
      })}
    </div>
  )

  return (
    <div
      role="menu"
      aria-label="Price scale"
      className="fixed z-50 w-60 rounded-md border bg-popover p-1 shadow-xl"
      style={{ left: x, top: y }}
      onMouseLeave={() => setSub(null)}
    >
      <button
        type="button"
        role="menuitem"
        className={row}
        onMouseEnter={() => setSub(null)}
        onClick={() => run({ type: 'reset' })}
      >
        <RotateCcw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>Reset price scale</span>
        <Chord text={AXIS_CHORDS.reset} />
      </button>

      <Separator />
      {toggle('Auto (fits data to screen)', menu.autoFit, { type: 'autoFit' }, AXIS_CHORDS.autoFit)}
      {toggle('Scale price chart only', menu.priceOnly, { type: 'priceOnly' })}
      {toggle('Invert scale', menu.inverted, { type: 'invert' }, AXIS_CHORDS.invert)}

      <Separator />
      {orderedModes.map((mode) => (
        <button
          type="button"
          key={mode.value}
          role="menuitemradio"
          aria-checked={menu.mode === mode.value}
          className={row}
          onMouseEnter={() => setSub(null)}
          onClick={() => run({ type: 'mode', mode: mode.value })}
        >
          <CheckSlot on={menu.mode === mode.value} />
          <span>{MODE_LABELS[mode.value] ?? mode.label}</span>
          <Chord text={mode.chord} />
        </button>
      ))}

      <Separator />
      <button
        type="button"
        role="menuitem"
        className={row}
        onMouseEnter={() => setSub(null)}
        onClick={() => run({ type: 'side', side: other })}
      >
        <span className="w-3.5 shrink-0" />
        <span>{other === 'left' ? 'Move scale to left' : 'Move scale to right'}</span>
      </button>

      <Separator />
      <div className="relative" onMouseEnter={() => setSub('tag')}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={sub === 'tag'}
          className={cn(row, sub === 'tag' && 'bg-accent text-accent-foreground')}
          onClick={(e) => {
            e.stopPropagation()
            setSub((prev) => (prev === 'tag' ? null : 'tag'))
          }}
        >
          <span className="w-3.5 shrink-0" />
          <span>Labels</span>
          <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        </button>
        {sub === 'tag' && renderSubmenu('tag')}
      </div>

      <div className="relative" onMouseEnter={() => setSub('line')}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={sub === 'line'}
          className={cn(row, sub === 'line' && 'bg-accent text-accent-foreground')}
          onClick={(e) => {
            e.stopPropagation()
            setSub((prev) => (prev === 'line' ? null : 'line'))
          }}
        >
          <span className="w-3.5 shrink-0" />
          <span>Lines</span>
          <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        </button>
        {sub === 'line' && renderSubmenu('line')}
      </div>

      <Separator />
      <button
        type="button"
        role="menuitem"
        className={row}
        onMouseEnter={() => setSub(null)}
        onClick={onSettings}
      >
        <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>More settings...</span>
      </button>
    </div>
  )
}
