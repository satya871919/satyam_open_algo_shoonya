import type { LogoWatermarkOptions } from 'openalgo-charts'
import type { AppMode, ThemeMode } from '@/stores/themeStore'

type LogoVariant = 'full' | 'mark'

export function brandLogoSrc(
  mode: ThemeMode,
  appMode: AppMode,
  variant: LogoVariant = 'mark'
): string {
  const tone = mode === 'dark' || appMode === 'analyzer' ? 'dark' : 'light'
  return `/images/sp-trading-${variant}-${tone}.png`
}

export function brandMarkSrc(mode: ThemeMode, appMode: AppMode): string {
  return brandLogoSrc(mode, appMode, 'mark')
}

export function chartBrandingOptions(
  mode: ThemeMode,
  appMode: AppMode
): LogoWatermarkOptions {
  return {
    src: brandLogoSrc(mode, appMode, 'full'),
    position: 'bottom-left',
    height: 50,
    padding: 3,
    margin: 8,
    opacity: 0.8,
    label: 'SP Trading',
    labelColor: mode === 'dark' || appMode === 'analyzer' ? '#e4e8f4' : '#3c4354',
    href: undefined,
  }
}
