/** Lucide stroke-icon glyphs (Icon.vue presetIcons) + status dot. */
import type { ReactNode } from 'react'
import { C_ACCENT, C_DANGER, C_FAINT, C_SUCCESS, C_WARNING, type Tone } from './theme.ts'

/** Lucide stroke-icon base (24px grid, currentColor; Icon.vue presetIcons). */
export function Lucide({ size = 15, children }: { size?: number; children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Status glyph (StatusIcon.vue port): circle-check / circle-x / circle-dashed / circle-dot. */
export function StatusIcon({ tone, size = 13 }: { tone: Tone; size?: number }): ReactNode {
  const color = tone === 'ok' ? C_SUCCESS : tone === 'bad' ? C_DANGER : tone === 'warn' ? C_WARNING : C_FAINT
  return (
    <span style={{ display: 'inline-flex', flex: 'none', color }} aria-hidden="true">
      <Lucide size={size}>
        {tone === 'ok' && (<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>)}
        {tone === 'bad' && (<><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>)}
        {tone === 'warn' && (
          <>
            <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
            <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
            <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
            <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
            <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
            <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
            <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
            <path d="M6.391 3.721a10 10 0 0 1 2.69 2.7" />
          </>
        )}
        {tone === 'neutral' && (<><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1" /></>)}
        {tone === 'accent' && (<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>)}
      </Lucide>
    </span>
  )
}

/** Colored status dot (StatusDot.vue port; jobs / busy / loading states). */
export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }): ReactNode {
  const color = tone === 'ok' ? C_SUCCESS : tone === 'warn' ? C_WARNING : tone === 'bad' ? C_DANGER : tone === 'accent' ? C_ACCENT : C_FAINT
  return (
    <span
      data-dshw-kanban={pulse === true ? 'pulse' : undefined}
      aria-hidden="true"
      style={{ display: 'inline-block', flex: 'none', width: 8, height: 8, borderRadius: '50%', background: color }}
    />
  )
}

export const GPlus = ({ size = 12 }: { size?: number }): ReactNode => <Lucide size={size}><path d="M5 12h14" /><path d="M12 5v14" /></Lucide>
export const GPencil = ({ size = 12 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Lucide>
)
export const GTrash = ({ size = 12 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </Lucide>
)
export const GKey = ({ size = 11 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
    <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
  </Lucide>
)
export const GGrip = ({ size = 13 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="5" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="15" cy="19" r="1" />
  </Lucide>
)
export const GDownload = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </Lucide>
)
export const GSync = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Lucide>
)
export const GReset = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Lucide>
)
export const GWorktree = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </Lucide>
)
export const GRepository = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 0-2 2Z" />
    <circle cx="13" cy="12" r="2" />
  </Lucide>
)
export const GAlert = ({ size = 13 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </Lucide>
)
export const GClose = ({ size = 15 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Lucide>
)
export const GGitGraph = ({ size = 15 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="5" cy="6" r="3" />
    <path d="M5 9v6" />
    <circle cx="5" cy="18" r="3" />
    <path d="M12 3v18" />
    <circle cx="19" cy="6" r="3" />
    <path d="M16 15.7A9 9 0 0 0 19 9" />
  </Lucide>
)
export const GSettings = ({ size = 15 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Lucide>
)
