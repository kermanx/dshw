import { defineConfig, presetIcons, presetUno } from 'unocss'

// 设计约定：
// - 整套配色照抄 VS Code Light Modern（见 style.css 注释），颜色一律引用 CSS 变量
// - 中性色承担界面，success/warn/danger/accent 只出现在状态与主操作上
// - 圆角体系：rounded = 4px(VS Code 控件) / rounded-md = 6px(气泡) / rounded-3px(徽章) / rounded-full 不用
export default defineConfig({
  presets: [presetUno(), presetIcons()],
  // st-* 在模板里以 `st-${tone}` 动态拼接，扫描器抓不到，需 safelist
  safelist: ['st-ok', 'st-warn', 'st-bad', 'st-neutral'],
  theme: {
    colors: {
      surface: 'var(--surface)',
      alt: 'var(--hover)',
      widget: 'var(--widget)',
      tabbar: 'var(--tabbar)',
      'tab-inactive': 'var(--tab-inactive)',
      titlebar: 'var(--titlebar)',
      line: 'var(--border)',
      'line-strong': 'var(--border-strong)',
      fg: 'var(--text)',
      secondary: 'var(--text-secondary)',
      muted: 'var(--text-muted)',
      faint: 'var(--text-faint)',
      link: 'var(--link)',
      accent: 'var(--accent)',
      'accent-hover': 'var(--accent-hover)',
      'accent-soft': 'var(--accent-soft)',
      success: 'var(--success)',
      'success-soft': 'var(--success-soft)',
      warn: 'var(--warning)',
      'warn-soft': 'var(--warning-soft)',
      danger: 'var(--danger)',
      'danger-soft': 'var(--danger-soft)',
      badge: 'var(--badge)',
      'badge-fg': 'var(--badge-fg)',
      statusbar: 'var(--statusbar)',
      'statusbar-fg': 'var(--statusbar-fg)',
      'statusbar-item-hover': 'var(--statusbar-item-hover)',
      'statusbar-alert': 'var(--statusbar-alert)',
      focus: 'var(--focus)',
      'code-bg': 'var(--code-bg)',
      'code-text': 'var(--code-text)',
      overlay: 'var(--overlay)',
    },
    fontFamily: {
      sans: 'var(--font-sans)',
      mono: 'var(--font-mono)',
    },
    boxShadow: {
      pop: 'var(--shadow)',
    },
  },
  shortcuts: [
    // 状态文字着色：分类状态统一用语义色
    [/^st-(ok|warn|bad|neutral)$/, ([, t]) => ({
      ok: 'text-success',
      warn: 'text-warn',
      bad: 'text-danger',
      neutral: 'text-muted',
    }[t] ?? '')],
    {
      'truncate': 'overflow-hidden text-ellipsis whitespace-nowrap',
      'muted': 'text-muted',
      'faint': 'text-faint',
      'mono': 'font-mono',
      // 按钮照抄 .monaco-button：无边框、4px 圆角；primary = #007acc，secondary = #f0f0f0
      'btn': 'h-26px inline-flex items-center gap-5px px-11px rounded text-12px leading-none whitespace-nowrap cursor-pointer transition-colors duration-100 disabled:opacity-45 disabled:pointer-events-none',
      'btn-default': 'bg-alt text-secondary hover:bg-widget',
      'btn-primary': 'bg-accent text-white hover:bg-accent-hover',
      'btn-danger': 'text-danger hover:bg-danger-soft',
      'btn-ghost': 'text-secondary hover:bg-alt',
      'btn-sm': '!h-22px !px-7px !text-11.5px',
      'icon-btn': 'h-26px w-26px inline-grid place-items-center rounded text-secondary cursor-pointer transition-colors duration-100 hover:bg-alt hover:text-fg',
      // 徽章照抄 .monaco-count-badge
      'badge': 'inline-flex items-center justify-center min-w-16px px-4px rounded-3px bg-badge text-badge-fg text-10.5px leading-14px',
      // 表格双行单元格
      'cell-main': 'flex items-center gap-6px min-w-0 h-20px text-13px font-500 text-fg',
      'cell-sub': 'h-16px mt-1px truncate text-muted text-11.5px',
      'empty-state': 'h-full flex flex-col items-center justify-center gap-2px text-muted text-12.5px',
    },
  ],
})
