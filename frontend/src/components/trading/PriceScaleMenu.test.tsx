import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PriceAxisMenu } from '@/lib/trading/priceAxis'
import { PriceScaleMenu } from './PriceScaleMenu'

const menu = (patch: Partial<PriceAxisMenu> = {}): PriceAxisMenu => ({
  autoFit: true,
  priceOnly: false,
  inverted: false,
  mode: 'linear',
  side: 'right',
  levels: [
    { kind: 'lastPrice', label: 'Last price', line: true, tag: true, available: true },
    { kind: 'previousClose', label: 'Previous close', line: false, tag: false, available: true },
    { kind: 'bid', label: 'Bid', line: false, tag: false, available: false },
    { kind: 'ask', label: 'Ask', line: false, tag: true, available: false },
  ],
  ...patch,
})

function open(state = menu()) {
  const onCommand = vi.fn()
  const onSettings = vi.fn()
  render(
    <PriceScaleMenu menu={state} x={10} y={10} onCommand={onCommand} onSettings={onSettings} />
  )
  return { onCommand, onSettings }
}

describe('PriceScaleMenu', () => {
  it('shows each row with its state and its chord', () => {
    open(menu({ mode: 'logarithmic', inverted: true }))
    expect(
      screen.getByRole('menuitemcheckbox', { name: /Auto \(fits data to screen\)/ })
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemcheckbox', { name: /Auto/ })).toHaveTextContent('Alt+A')
    expect(screen.getByRole('menuitemcheckbox', { name: /Invert scale/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('menuitemradio', { name: /Logarithmic/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('menuitemradio', { name: /Regular/ })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByRole('menuitemradio', { name: /Percent/ })).toHaveTextContent('Alt+P')
    expect(screen.getByRole('menuitemradio', { name: /Indexed to 100/ })).toHaveTextContent('Alt+1')
    expect(screen.getByRole('menuitem', { name: /Reset price scale/ })).toHaveTextContent('Alt+R')
    expect(screen.getByRole('menuitem', { name: 'Move scale to left' })).toBeInTheDocument()
  })

  it('runs a row and lets the menu close', () => {
    const { onCommand, onSettings } = open()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Percent/ }))
    expect(onCommand).toHaveBeenLastCalledWith({ type: 'mode', mode: 'percentage' }, false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move scale to left' }))
    expect(onCommand).toHaveBeenLastCalledWith({ type: 'side', side: 'left' }, false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'More settings...' }))
    expect(onSettings).toHaveBeenCalledTimes(1)
  })

  it('switches a level half inside Labels/Lines submenus and keeps the menu open', () => {
    const { onCommand } = open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lines' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Previous close line' }))
    expect(onCommand).toHaveBeenLastCalledWith(
      { type: 'level', kind: 'previousClose', half: 'line', on: true },
      true
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Labels' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Last price axis tag' }))
    expect(onCommand).toHaveBeenLastCalledWith(
      { type: 'level', kind: 'lastPrice', half: 'tag', on: false },
      true
    )
  })

  it('greys a level with no data, and still lets one already on be switched off', () => {
    const { onCommand } = open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lines' }))
    expect(screen.getAllByText('no data')).toHaveLength(2)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Bid line' })).toBeDisabled()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Ask line' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Labels' }))
    const askTag = screen.getByRole('menuitemcheckbox', { name: 'Ask axis tag' })
    expect(askTag).toBeEnabled()
    fireEvent.click(askTag)
    expect(onCommand).toHaveBeenLastCalledWith(
      { type: 'level', kind: 'ask', half: 'tag', on: false },
      true
    )
  })
})
