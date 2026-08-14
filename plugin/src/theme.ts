/** dshw design tokens (ui/src/style.css — VS Code Light Modern palette) + status tone. */

/** Status accent (ui/src/types.ts Tone). */
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'

export const C_SURFACE = '#ffffff'
export const C_TEXT = '#333333'
export const C_SECONDARY = '#616161'
export const C_MUTED = '#717171'
export const C_FAINT = '#9a9a9a'
export const C_LINK = '#006ab1'
export const C_ACCENT = '#007acc'
export const C_ACCENT_SOFT = 'rgba(0, 122, 204, .12)'
export const C_SUCCESS = '#388a34'
export const C_WARNING = '#bf8803'
export const C_DANGER = '#a1260d'
export const C_HOVER = '#f0f0f0'
export const C_WIDGET = '#f3f3f3'
export const C_BORDER = '#e7e7e7'
export const C_BADGE = '#c4c4c4'
export const C_BADGE_FG = '#333333'
export const C_WARN_SOFT = 'rgba(191, 136, 3, .12)'
export const C_OVERLAY = 'rgba(0, 0, 0, .32)'
export const C_SHADOW_POP = '0 4px 16px rgba(0, 0, 0, .16), 0 0 2px rgba(0, 0, 0, .08)'
export const FONT_MONO = 'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace'

/* Semantic status colors (uno.config.ts st-*): text uses muted for neutral. */
export const ok = C_SUCCESS
export const warn = C_WARNING
export const bad = C_DANGER

export const toneColor = (tone: Tone): string => tone === 'ok' ? C_SUCCESS : tone === 'warn' ? C_WARNING : tone === 'bad' ? C_DANGER : tone === 'accent' ? C_ACCENT : C_MUTED
