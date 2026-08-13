/**
 * Ambient type shims for the dsh client platform modules this bundle imports
 * at runtime. The real implementations come from the harness web shell's
 * module table (react, react-dom, @deepseek-ai/dsh-client-ui-primitives are
 * seeded platform modules; @deepseek-ai/dsh-client-runtime/client is the
 * client plugin context). These declarations only make this package typecheck
 * standalone — they are compile-time only and are erased from the bundle.
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** Client plugin context (the slice this plugin uses). */
  export interface ClientContext {
    /** Register an effect whose disposer runs when this plugin unloads. */
    effect(fn: () => void | (() => void), label?: string): void
    /** The locale registry service (browser half). */
    locale: {
      /** Register a zh/en dictionary pair under a namespace. */
      register(ns: string, dicts: Record<string, Record<string, string>>): void
    }
    /** The slot registry service (browser half). */
    slots: {
      /** Contribute a registration once the named slot is declared; returns the disposer. */
      inject(slotName: string, factory: () => unknown): unknown
      /** Register an occupant component into a declared slot. */
      register(options: SlotRegisterOptions, component: unknown): unknown
    }
  }

  /** Registration options for one slot occupant. */
  export interface SlotRegisterOptions {
    /** Slot key the occupant fills (must be declared by the renderer's entry). */
    name: string
    /** List-kind entry identity. */
    id?: string
    /** List-kind position. */
    order?: number
    /** Locale namespace binding the framework `t` seat from. */
    locale?: string
    /** Child slots this entry declares and renders. */
    children?: Record<string, { kind: 'single' | 'list' | 'keyed' | 'chain'; scope: 'root' | 'session' | 'session-maybe' }>
    /** Per-render inject face. */
    inject?: () => unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  /** Shared icon props. */
  export interface IconProps {
    size?: number
    className?: string
  }

  /** Sidebar-foot kanban entry icons used by this plugin. */
  export const IconBranchOutline16: (props: IconProps) => ReactElement
  export const IconCloseOutline16: (props: IconProps) => ReactElement
  export const IconRefreshOutline16: (props: IconProps) => ReactElement
  export const IconRightUpOutline16: (props: IconProps) => ReactElement

  /** Tooltip primitive wrapping a trigger element. */
  export interface TooltipProps {
    label: string
    side?: 'top' | 'bottom' | 'left' | 'right'
    delayMs?: number
    disabled?: boolean
    children: ReactElement
  }
  export function Tooltip(props: TooltipProps): ReactElement
}

declare module 'react-dom' {
  import type { ReactNode } from 'react'

  /** Render children into a DOM node outside the React tree. */
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactNode
}
