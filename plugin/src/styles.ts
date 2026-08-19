/** Shared dshw view styles (VS Code Light palette). View-local styles live
 *  next to their views; this module holds the cross-view surfaces: tables,
 *  empty states, strips, action links, popovers, dialogs, jobs/logs cells
 *  and the workspace tab bar. */
import type { CSSProperties } from 'react'
import { warn, C_ACCENT, C_ACCENT_SOFT, C_BADGE, C_BADGE_FG, C_BORDER, C_DANGER, C_FAINT, C_HOVER, C_LINK, C_MUTED, C_OVERLAY, C_SECONDARY, C_SURFACE, C_TEXT, C_WARN_SOFT, C_WIDGET, C_SHADOW_POP, FONT_MONO } from './theme.ts'

/* ── styles ── */

export const rootStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: C_SURFACE,
}

export const errorStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 32,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  color: C_SECONDARY,
  background: C_WARN_SOFT,
}

export const errorStripTextStyle: CSSProperties = { color: C_SECONDARY }

export const loadingStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 32,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  color: C_SECONDARY,
  background: C_HOVER,
}

/** Repo group row inside the shared table (multi-repo kanban): one header row
 *  per repo that collapses/expands its PR rows. */
export const repoGroupRowStyle: CSSProperties = {
  background: C_HOVER,
  cursor: 'pointer',
  userSelect: 'none',
}

export const repoGroupCellStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  verticalAlign: 'middle',
}

export const repoGroupTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 12,
  fontWeight: 600,
  color: C_TEXT,
}

export const repoGroupTitleTextStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
}

/** Loading row shown under a repo group header while its data is refreshing. */
export const prLoadingRowStyle: CSSProperties = {
  height: 44,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  color: C_MUTED,
  fontSize: 12,
  textAlign: 'left',
}

export const tableScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  /* no horizontal inset: the PR / Reviews tables span the panel edge to edge
     (cells carry their own 12px padding); bottom padding only for scroll end. */
  paddingBottom: 16,
}

export const tableStyle: CSSProperties = {
  width: '100%',
  minWidth: 900,
  /* separate + spacing 0 (not collapse): with collapse, a sticky th breaks
     the table-layout:fixed column model in Chromium and the body cells fall
     back to content sizing — the header/body columns drift apart. */
  borderCollapse: 'separate',
  borderSpacing: 0,
  tableLayout: 'fixed',
}

export const thStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: C_SECONDARY,
  position: 'sticky',
  top: 0,
  zIndex: 1,
  background: C_SURFACE,
}

export const trStyle: CSSProperties = { }

export const tdStyle: CSSProperties = {
  height: 54,
  padding: '5px 12px',
  verticalAlign: 'middle',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const draftRowStyle: CSSProperties = { opacity: 0.7, filter: 'saturate(0.5)' }

export const cellMainStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }

export const titleLinkStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  overflow: 'hidden',
  color: 'inherit',
}

export const numberStyle: CSSProperties = { flex: 'none', fontFamily: 'monospace', fontSize: 12, color: C_MUTED }

export const titleStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  fontSize: 13,
  color: C_TEXT,
}

export const draftBadgeStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_BADGE,
  color: C_BADGE_FG,
}

export const cellSubStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  height: 16,
  marginTop: 1,
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  color: C_MUTED,
}

export const subTextStyle: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/** “assign 给我的 PR”标识：作者不是自己，用 accent 底色与草稿徽标区分。 */
export const assignedBadgeStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 5px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_ACCENT_SOFT,
  color: C_ACCENT,
}

export const gitChipStyle: CSSProperties = {
  flex: 'none',
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  fontWeight: 600,
  color: warn,
  cursor: 'pointer',
  border: 'none',
  lineHeight: '18px',
}

export const cellColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, minWidth: 0 }

export const popoverTriggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  width: 'fit-content',
  minWidth: 0,
  padding: 0,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12.5,
  textAlign: 'left',
}

export const statusGlyphStyle: CSSProperties = { display: 'inline-flex', flex: 'none' }

export const statusTextStyle: CSSProperties = { whiteSpace: 'nowrap', color: 'inherit' }

export const countStyle: CSSProperties = { flex: 'none', fontFamily: 'monospace', fontSize: 11, color: C_MUTED }

export const cellNoteRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }

export const cellNoteStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: C_MUTED,
}

export const noteSeparatorStyle: CSSProperties = { flex: 'none', fontSize: 11.5, color: C_MUTED }

export const actionLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  flex: 'none',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: C_LINK,
  fontFamily: 'inherit',
}

export const busyRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  fontSize: 11.5,
  color: C_LINK,
}

export const mergeableLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  height: 20,
  fontSize: 12.5,
  whiteSpace: 'nowrap',
}

export const syncCellStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }

export const syncSwitchRowStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 20 }

export const syncSwitchStyle = (on: boolean): CSSProperties => ({
  position: 'relative',
  flex: 'none',
  width: 26,
  height: 14,
  borderRadius: 7,
  border: 'none',
  cursor: 'pointer',
  transition: 'background-color 150ms',
  background: on ? C_ACCENT : C_BADGE,
})

export const syncKnobStyle = (on: boolean): CSSProperties => ({
  position: 'absolute',
  top: 2,
  left: 2,
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
  transition: 'transform 150ms',
  transform: on ? 'translateX(12px)' : 'none',
})

export const syncLabelStyle: CSSProperties = { fontSize: 12.5, whiteSpace: 'nowrap', color: C_MUTED }

export const pausedButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: warn,
  fontFamily: 'inherit',
}

export const popoverStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 120,
  overflow: 'auto',
  padding: 4,
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
  boxSizing: 'border-box',
}

export const popoverEmptyStyle: CSSProperties = { padding: '8px 10px', fontSize: 12, color: C_MUTED }

export const popoverRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 26,
  padding: '0 8px',
  borderRadius: 6,
  fontSize: 12,
  color: C_SECONDARY,
  textDecoration: 'none',
}

export const popoverRowTextStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export const popoverRowBadgeStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', fontSize: 11.5, whiteSpace: 'nowrap' }

export const popoverSectionStyle: CSSProperties = { paddingBottom: 4 }

export const popoverSectionSpacedStyle: CSSProperties = { marginTop: 3, paddingTop: 4, borderTop: `1px solid ${C_BORDER}` }

export const popoverSectionTitleStyle: CSSProperties = { padding: '4px 7px', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: C_MUTED }

export const popoverPersonRowStyle: CSSProperties = { ...popoverRowStyle, minHeight: 32 }

export const avatarStyle: CSSProperties = { width: 20, height: 20, borderRadius: '50%', flex: 'none', objectFit: 'cover', background: C_HOVER }

export const avatarStackStyle: CSSProperties = { display: 'inline-flex', flex: 'none', alignItems: 'center', paddingLeft: 3 }

export const stackAvatarStyle: CSSProperties = { width: 16, height: 16, marginLeft: -3, borderRadius: '50%', flex: 'none', objectFit: 'cover', border: `1px solid ${C_SURFACE}` }

export const stackMoreStyle: CSSProperties = { marginLeft: 3, fontSize: 10.5, color: C_MUTED }

export const conflictPathStyle: CSSProperties = { padding: '2px 0', fontFamily: 'monospace', fontSize: 11.5, lineHeight: 1.45, overflowWrap: 'anywhere', color: C_SECONDARY }

export const popoverActionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 28,
  padding: '0 7px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 12,
  color: C_SECONDARY,
  fontFamily: 'inherit',
}

export const dialogOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 130,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

export const dialogMaskStyle: CSSProperties = { position: 'absolute', inset: 0, background: C_OVERLAY }

export const dialogStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 380,
  maxWidth: 'calc(100vw - 32px)',
  padding: 16,
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 12,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
}

export const dialogTitleStyle: CSSProperties = { marginBottom: 10, fontSize: 13, fontWeight: 500, color: C_TEXT }

export const dialogListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflow: 'auto' }

export const dialogWorkerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minHeight: 34,
  padding: '0 10px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}

export const dialogWorkerNameStyle: CSSProperties = { fontSize: 13, color: C_TEXT }

export const dialogWorkerTypeStyle: CSSProperties = { fontSize: 11.5, color: C_MUTED }

export const dialogInputStyle: CSSProperties = {
  marginTop: 10,
  height: 34,
  padding: '0 10px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: C_TEXT,
}

export const dialogCloseRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 12 }

export const dialogCancelStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_SECONDARY,
}

export const emptyStateStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  height: '100%',
  minHeight: 200,
  fontSize: 12.5,
  color: C_MUTED,
}

export const emptyStateLineStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: C_SECONDARY }

export const emptyStateTitleStyle: CSSProperties = { margin: 0, fontSize: 13, color: C_SECONDARY }

export const emptyStateSubStyle: CSSProperties = { margin: 0, fontSize: 12, color: C_MUTED }

export const toastStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 140,
  maxWidth: 420,
  padding: '8px 14px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
  fontSize: 12.5,
  color: C_TEXT,
}

/* ── tab bar + view area ── */

export const tabbarStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'stretch',
  height: 35,
  overflowX: 'auto',
  borderBottom: `1px solid ${C_BORDER}`,
  background: C_WIDGET,
}

export const tabStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 12px',
  border: 'none',
  background: active ? C_SURFACE : '#ececec',
  color: active ? C_TEXT : 'rgba(51, 51, 51, .7)',
  fontFamily: 'inherit',
  fontSize: 12.5,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
})

export const tabCountStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_BADGE,
  color: C_BADGE_FG,
}

/* ── worker launch dialog（WorkerLaunchDialog.vue 移植：radio 单选 + 附加指令 + 启动任务） ── */

export const workerPickerOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 130,
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  background: C_OVERLAY,
}

export const workerPickerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(440px, 100%)',
  maxHeight: 'calc(100vh - 48px)',
  boxSizing: 'border-box',
  overflow: 'hidden',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 4,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
}

export const workerPickerHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minHeight: 58,
  padding: '10px 14px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const workerPickerTitleStyle: CSSProperties = { margin: 0, fontSize: 13.5, fontWeight: 600, color: C_TEXT }

export const workerPickerSubtitleStyle: CSSProperties = { marginTop: 1, fontSize: 11, color: C_MUTED }

export const workerPickerBodyStyle: CSSProperties = {
  flex: 'none',
  overflow: 'auto',
  maxHeight: 'min(480px, calc(100vh - 180px))',
  padding: 12,
  boxSizing: 'border-box',
}

export const workerPickerLegendStyle: CSSProperties = { marginBottom: 5, fontSize: 11.5, fontWeight: 500, color: C_SECONDARY }

export const workerPickerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 48,
  padding: '0 9px',
  boxSizing: 'border-box',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

export const workerPickerRowTextStyle: CSSProperties = { flex: 1, minWidth: 0 }

export const workerPickerNameRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }

export const workerPickerNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: 500, color: C_TEXT }

export const workerPickerSublineStyle: CSSProperties = {
  display: 'block',
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_MUTED,
}

export const workerPickerEmptyStyle: CSSProperties = { padding: '26px 0', textAlign: 'center', fontSize: 12, color: C_MUTED }

export const workerPickerFieldLabelStyle: CSSProperties = { display: 'block', marginTop: 12, fontSize: 11.5, fontWeight: 500, color: C_SECONDARY }

export const workerPickerTextareaStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 76,
  marginTop: 5,
  boxSizing: 'border-box',
  resize: 'vertical',
  padding: '7px 9px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 4,
  background: C_SURFACE,
  outline: 'none',
  color: C_TEXT,
  fontSize: 12.5,
  lineHeight: '18px',
  fontFamily: 'inherit',
}

export const workerPickerFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  height: 48,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
}

export const workerPickerGhostStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_SECONDARY,
}

export const workerPickerCloseStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  flex: 'none',
  border: 'none',
  borderRadius: 8,
  padding: 0,
  cursor: 'pointer',
  color: C_SECONDARY,
}

export const viewAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
}

/* ── reviews / jobs / logs shared cell styles ── */

export const authorStyle: CSSProperties = { fontSize: 12.5, color: C_SECONDARY }

export const timeStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 11, whiteSpace: 'nowrap', color: C_FAINT }

export const tdCompactStyle: CSSProperties = {
  height: 32,
  padding: '0 12px',
  verticalAlign: 'middle',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const cellBlockStyle: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  color: C_SECONDARY,
}

export const jobSummaryStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
  color: C_TEXT,
}

export const logMessageStyle: CSSProperties = {
  display: 'block',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
  color: C_SECONDARY,
}

export const dangerButtonStyle: CSSProperties = {
  flex: 'none',
  marginLeft: 'auto',
  height: 22,
  padding: '0 8px',
  border: `1px solid ${C_DANGER}`,
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_DANGER,
}

export const jobsScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

export const jobsFooterStyle: CSSProperties = {
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  fontSize: 11.5,
  color: C_MUTED,
}


/* ── shared dialog shell (headers / close / footer / action buttons) ── */

export const dialogHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 46,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const jobDialogTitleStyle: CSSProperties = { fontSize: 13.5, fontWeight: 600, color: C_TEXT }

export const jobDialogStatusStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap' }

export const dialogCloseButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  color: C_SECONDARY,
  fontFamily: 'inherit',
  fontSize: 13,
}

export const dialogActionButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_SECONDARY,
}

export const steerInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: '0 10px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 7,
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_TEXT,
}

export const dialogFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minHeight: 48,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
}

export const primaryButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: C_ACCENT,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: '#fff',
}
