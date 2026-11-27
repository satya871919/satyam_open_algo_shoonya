import { describe, expect, it } from 'vitest'
import {
  convertExpiryForAPI,
  formatExpiryLabel,
  formatIndianOI,
  OPEN_INTEREST_DESCRIPTOR,
  pickActiveExpiries,
  resolveOptionTarget,
} from './oiProfileIndicator'

describe('oiProfileIndicator', () => {
  it('resolves index, equity, and futures symbols to option targets', () => {
    expect(resolveOptionTarget('NIFTY', 'NSE_INDEX')).toEqual({
      underlying: 'NIFTY',
      optionsExchange: 'NFO',
    })
    expect(resolveOptionTarget('SENSEX', 'BSE_INDEX')).toEqual({
      underlying: 'SENSEX',
      optionsExchange: 'BFO',
    })
    expect(resolveOptionTarget('RELIANCE', 'NSE')).toEqual({
      underlying: 'RELIANCE',
      optionsExchange: 'NFO',
    })
    expect(resolveOptionTarget('NIFTY26DEC26FUT', 'NFO')).toEqual({
      underlying: 'NIFTY',
      optionsExchange: 'NFO',
    })
    expect(resolveOptionTarget('BTCUSD', 'CRYPTO')).toBeNull()
  })

  it('formats OI in Indian units (Cr / Lac / K)', () => {
    expect(formatIndianOI(0)).toBe('0')
    expect(formatIndianOI(10_900_000)).toBe('1.09 Cr')
    expect(formatIndianOI(2_994_000)).toBe('29.94 Lac')
    expect(formatIndianOI(45_200)).toBe('45.2 K')
  })

  it('formats expiry codes into readable dates', () => {
    expect(formatExpiryLabel('01DEC26')).toBe('Dec 1, 2026')
    expect(formatExpiryLabel('26-NOV-2026')).toBe('Nov 26, 2026')
  })

  it('exposes Open Interest Shoonya indicator descriptor', () => {
    expect(OPEN_INTEREST_DESCRIPTOR.id).toBe('open-interest-profile')
    expect(OPEN_INTEREST_DESCRIPTOR.name).toBe('Open Interest Shoonya')
    expect(OPEN_INTEREST_DESCRIPTOR.placement).toBe('onchart')
    const out = OPEN_INTEREST_DESCRIPTOR.calc(
      [{ time: 1, open: 100, high: 101, low: 99, close: 100 }],
      {}
    )
    expect(out._oi).toEqual([null])
  })

  it('converts expiry strings and auto-advances after 15:30 IST on expiry day', () => {
    expect(convertExpiryForAPI('01-DEC-2026')).toBe('01DEC26')
    expect(convertExpiryForAPI('26-NOV-26')).toBe('26NOV26')

    const expiries = ['27-NOV-26', '03-DEC-26', '10-DEC-26']
    // 2026-11-27 14:00 IST (08:30 UTC) -> today's expiry still active
    const beforeClose = Date.UTC(2026, 10, 27, 8, 30, 0)
    expect(pickActiveExpiries(expiries, 'NFO', beforeClose)[0]).toBe('27-NOV-26')

    // 2026-11-27 16:00 IST (10:30 UTC) -> today's expiry ended, auto-advance to next
    const afterClose = Date.UTC(2026, 10, 27, 10, 30, 0)
    expect(pickActiveExpiries(expiries, 'NFO', afterClose)[0]).toBe('03-DEC-26')
  })
})
