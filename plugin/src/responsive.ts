/*
 * UI reference skill: vscode-ui
 * Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
 * Reference components: SidebarTitle, ActionBar, SelectBox, Pane, List, Hover.
 * Adaptation: Container-sized navigation, compact summaries and disclosed
 * workflow actions inside a narrow sidebar; wide layouts retain their tables.
 * PR workflows and the expanded surface are project-specific compositions.
 * Copyright (c) Microsoft Corporation. All rights reserved. MIT License;
 * see ../LICENSE.vscode-ui.txt.
 */
export const RESPONSIVE_STYLES = `
.dshw-panel { position: relative; container: dshw-panel / inline-size; width: 100%; height: 100%; }
.dshw-panel[data-expanded] {
  position: fixed; inset: 8px 8px 8px 48px; width: auto; height: auto; z-index: 90;
  border: 1px solid var(--vscode-widget-border, #c8c8c8);
  box-shadow: 0 2px 12px #0002;
}
.dshw-panel-header > span:last-child { flex: none; }
.dshw-expand-control { display: none !important; }
.dshw-panel[data-expanded] .dshw-expand-control { display: inline-flex !important; }
.dshw-panel :is(button, select, input, summary, [tabindex]):focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: -1px;
}
.dshw-panel .dshw-trigger:hover { text-decoration: none; }
[data-dshw-popover] { border-radius: 5px !important; border-color: var(--vscode-editorHoverWidget-border, #c8c8c8) !important; }
.dshw-workspace, .dshw-view-area, .dshw-view-body { min-width: 0; }
.dshw-view-picker { display: none; }
.dshw-pr-compact { display: none; }
.dshw-view-picker select {
  width: 100%; min-width: 0; height: 26px; padding: 2px 6px;
  font: inherit; font-size: 12px; border-radius: 0;
  border: 1px solid var(--vscode-dropdown-border, #cecece);
  color: var(--vscode-dropdown-foreground, #333);
  background: var(--vscode-dropdown-background, #fff);
}
@container dshw-panel (max-width: 600px) {
  .dshw-panel .dshw-panel-header { min-height: 35px !important; height: 35px; gap: 8px !important; background: var(--vscode-sideBar-background, #f3f3f3) !important; }
  .dshw-panel .dshw-panel-header button { width: 22px !important; height: 22px !important; border-radius: 4px !important; flex: none; }
  .dshw-panel .dshw-expand-control { display: inline-flex !important; }
  .dshw-logo, .dshw-subtitle { display: none !important; }
  .dshw-panel:has(.dshw-workspace) .dshw-title-group { visibility: hidden; }
  .dshw-panel-header [data-panel-action="close"] { display: none !important; }
  .dshw-panel .dshw-view-tabs { display: none !important; }
  .dshw-view-picker { display: block; position: absolute; top: 4px; left: 8px; right: 82px; }
  .dshw-url-field { width: 100%; flex-direction: column; align-items: stretch !important; }
  .dshw-url-field input { width: 100% !important; }

  /* Flat list entries, with the same live cells and action handlers as the
     full-width table. No cards, nested boxes, or horizontal table scrolling. */
  [data-dshw-table] { display: block; min-width: 0 !important; width: 100% !important; }
  [data-dshw-table] > thead {
    position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);
  }
  [data-dshw-table] > tbody { display: block; }
  [data-dshw-table] > tbody > tr {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border, #e7e7e7);
  }
  [data-dshw-table] > tbody > tr > td {
    display: block; min-width: 0; height: auto !important; padding: 0 !important;
    border: 0 !important; overflow-wrap: anywhere;
  }
  [data-dshw-table] td[colspan] { grid-column: 1 / -1; }
  [data-dshw-table] tr[data-dshw-kanban="repogroup"] { padding: 5px 12px; }
  [data-dshw-table] [data-dshw-kanban="titlelink"] { align-items: baseline !important; }
  [data-dshw-table] [data-dshw-kanban="titlelink"] > span:last-child {
    white-space: normal !important; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  }
  [data-dshw-table="reviews"] tr > td:first-child { grid-column: 1 / -1; }
  [data-dshw-table="settings"] td[data-label]:not([data-label=""])::before {
    content: attr(data-label); display: block; font-size: 10px;
    color: var(--vscode-descriptionForeground, #717171); margin-bottom: 1px;
  }
  /* Hover paints one continuous row, including the gaps between fields. */
  [data-dshw-table] > tbody > tr:not([data-dshw-kanban="repogroup"]):hover { background: var(--vscode-list-hoverBackground, #f0f0f0); }
  [data-dshw-table] > tbody > tr:hover > td { background: transparent !important; }
  [data-dshw-table="prs"] > tbody > tr[data-dshw-kanban="row"] { display: block; padding: 7px 12px; }
  [data-dshw-table="prs"] tr[data-dshw-kanban="row"] > td:not(.dshw-pr-compact) { display: none; }
  [data-dshw-table="prs"] tr[data-dshw-kanban="row"] > .dshw-pr-compact { display: block; position: relative; }
  .dshw-pr-title { padding-right: 20px; }
  .dshw-pr-title > div:first-child { align-items: baseline !important; }
  .dshw-pr-title > div:nth-child(2) > button { flex: none; }
  .dshw-pr-diff { position: absolute; right: -4px; top: 0; }
  .dshw-pr-diff > button { width: 22px !important; height: 22px !important; border-radius: 4px !important; }
  .dshw-pr-details > summary { display: flex; align-items: center; gap: 6px; min-height: 22px; list-style: none; cursor: pointer; font-size: 10.5px; color: var(--vscode-descriptionForeground, #717171); }
  .dshw-pr-details > summary::-webkit-details-marker { display: none; }
  .dshw-pr-details > summary > span { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
  .dshw-pr-details .dshw-disclosure { margin-left: auto; flex: none; }
  .dshw-pr-details[open] .dshw-disclosure { transform: rotate(180deg); }
  .dshw-pr-actions { display: flex; flex-direction: column; gap: 8px; padding-top: 5px; }
  .dshw-pr-actions > div { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 6px; align-items: start; }
  .dshw-pr-actions > div > span { font-size: 11px; color: var(--vscode-descriptionForeground, #717171); }
  .dshw-pr-actions > div > div > div { flex-wrap: wrap; }
  .dshw-pr-actions button { max-width: 100%; flex-wrap: wrap; }
  .dshw-pr-actions button > span:has(img) { display: none !important; }
  .dshw-pr-actions .dshw-link { white-space: normal !important; overflow-wrap: anywhere; }
  [data-dshw-table="reviews"] > tbody > tr { grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; }
  [data-dshw-table="jobs"] tr > td:nth-child(2),
  [data-dshw-table="jobs"] tr > td:nth-child(4),
  [data-dshw-table="logs"] tr > td:nth-child(3) { grid-column: 1 / -1; }
  [data-dshw-table="jobs"] tr > td:nth-child(2) { grid-row: 1; }
  [data-dshw-table="jobs"] tr > td:nth-child(2) > span { white-space: normal !important; overflow-wrap: anywhere; }
  [data-dshw-table="logs"] tr > td:nth-child(3) > span {
    white-space: normal !important; display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  }
  [data-dshw-table="jobs"] tr > td:last-child,
  [data-dshw-table="logs"] tr > td:last-child { grid-column: 1 / -1; }
  [data-dshw-table="jobs"] > tbody > tr { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: 'target target target' 'summary summary summary' 'status worker time'; }
  [data-dshw-table="jobs"] tr > td:nth-child(1) { grid-area: status; }
  [data-dshw-table="jobs"] tr > td:nth-child(2) { grid-area: target; }
  [data-dshw-table="jobs"] tr > td:nth-child(3) { grid-area: worker; }
  [data-dshw-table="jobs"] tr > td:nth-child(4) { grid-area: summary; }
  [data-dshw-table="jobs"] tr > td:nth-child(5) { grid-area: time; }

  .dshw-panel .dshw-settings-layout { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: auto minmax(0, 1fr) !important; }
  .dshw-settings-layout > aside {
    display: flex; gap: 2px; border-right: 0 !important;
    border-bottom: 1px solid var(--vscode-widget-border, #e7e7e7);
  }
  .dshw-settings-layout > aside > button { width: auto !important; flex: 1; gap: 4px !important; padding: 0 4px !important; border-radius: 0 !important; }
  .dshw-panel .dshw-section-header { height: auto !important; min-height: 35px; padding: 6px 12px !important; flex-wrap: wrap; gap: 4px 8px !important; }
  .dshw-panel .dshw-settings-card { padding: 8px !important; }
  .dshw-panel .dshw-system-row { display: grid !important; grid-template-columns: 28px minmax(0, 1fr); gap: 8px !important; padding: 10px !important; }
  .dshw-system-row > div { overflow-wrap: anywhere; }
  .dshw-system-row > div > div:first-child { flex-direction: column; align-items: flex-start !important; gap: 2px !important; }
  .dshw-system-row > button { grid-column: 2; justify-self: start; }
  .dshw-panel .dshw-repos-divider { flex-wrap: wrap; height: auto !important; gap: 6px !important; padding: 8px 12px !important; }
  .dshw-repos-divider input { width: 100% !important; }
  [data-dshw-table="settings"] > tbody > tr { grid-template-columns: 12px minmax(0, 1fr) auto; grid-template-areas: 'grip name actions' '. model status'; align-items: center; }
  [data-dshw-table="settings"] td[data-label]::before { display: none !important; }
  [data-dshw-table="settings"] tr > td:nth-child(1) { grid-area: grip; }
  [data-dshw-table="settings"] tr > td:nth-child(2) { grid-area: status; }
  [data-dshw-table="settings"] tr > td:nth-child(3) { grid-area: name; }
  [data-dshw-table="settings"] tr > td:nth-child(4) { display: none; }
  [data-dshw-table="settings"] tr > td:nth-child(5) { grid-area: model; }
  [data-dshw-table="settings"] tr > td:nth-child(6),
  [data-dshw-table="settings"] tr > td:nth-child(7),
  [data-dshw-table="settings"] tr > td:nth-child(8) { display: none; }
  [data-dshw-table="settings"] tr > td:nth-child(9) { grid-area: actions; align-self: center; }

  .dshw-panel .dshw-git-layout { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: minmax(120px, 38%) minmax(0, 1fr) !important; }
  .dshw-git-layout > aside { border-right: 0 !important; border-bottom: 1px solid var(--vscode-widget-border, #e7e7e7); }
  .dshw-git-layout > section { min-width: 0; }
}
`
