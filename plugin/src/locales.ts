/** `kanban` namespace dictionaries for the dshw dashboard entry. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.label': '看板',
  'action.aria': '打开 dshw 看板',
  'panel.title': 'dshw 看板',
  'panel.code': '在 VS Code 中打开 workspace',
  'panel.openBrowser': '在浏览器中打开',
  'panel.refresh': '刷新',
  'panel.close': '关闭',
  'panel.loading': '正在连接 dshw daemon…',
  'panel.unreachable.title': '无法连接 dshw 服务',
  'panel.unreachable.detail': '在 {url} 没有检测到运行中的 dshw daemon。请先启动 dshw（pnpm dshw start），或者修改服务地址后重试。',
  'panel.url.label': '服务地址',
  'panel.url.save': '保存并重试',
} satisfies Record<string, string>

/** The kanban namespace key union. */
export type KanbanKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.label': 'Kanban',
  'action.aria': 'Open the dshw kanban',
  'panel.title': 'dshw Kanban',
  'panel.code': 'Open the workspace in VS Code',
  'panel.openBrowser': 'Open in browser',
  'panel.refresh': 'Refresh',
  'panel.close': 'Close',
  'panel.loading': 'Connecting to the dshw daemon…',
  'panel.unreachable.title': 'Cannot reach the dshw service',
  'panel.unreachable.detail': 'No running dshw daemon was found at {url}. Start dshw first (pnpm dshw start), or change the service address and retry.',
  'panel.url.label': 'Service URL',
  'panel.url.save': 'Save and retry',
} satisfies Record<KanbanKey, string>
