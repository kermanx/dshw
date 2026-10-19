/**
 * Browser half of the dshw kanban plugin (the ./client bundle, built by
 * `pnpm run build:plugin` into plugin/lib/client.js). Types mirror the
 * runtime exports of plugin/src/index.tsx.
 */

/** Services required before the entry activates. */
export declare const inject: string[]

/** Register the standard sidebar entry and its main panel. */
export declare function apply(ctx: unknown): void
