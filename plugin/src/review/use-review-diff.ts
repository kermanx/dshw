/** Review diff data hooks: manifest fetch + lazy, cached per-file payloads
 *  and full-file content. Caches are module-level so they survive unmounts
 *  (single-file ↔ continuous mode switches and near-viewport lazy mounting). */
import { useCallback, useEffect, useState } from 'react'
import type { ReviewDiffManifest, ReviewDiffPayload, ReviewRequestRecord } from '../../../src/types.ts'

const payloadCache = new Map<string, ReviewDiffPayload>()
const contentCache = new Map<string, { content: string; truncated: boolean }>()

export interface ReviewDiffLoadState {
  manifest?: ReviewDiffManifest
  loading: boolean
  error?: string
  refresh: () => void
}

/** Fetch the review diff manifest; the daemon prepares the local clone first. */
export function useReviewDiff(baseUrl: string, review: ReviewRequestRecord): ReviewDiffLoadState {
  const [state, setState] = useState<{ manifest?: ReviewDiffManifest; loading: boolean; error?: string }>({ loading: true })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState(current => ({ ...current, loading: true, error: undefined }))
    const url = `${baseUrl}/api/reviews/${review.repoSlug}/${String(review.number)}/diff`
    void fetch(url, { signal: AbortSignal.timeout(180_000) }).then(async response => {
      const value = await response.json() as ReviewDiffManifest & { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      if (!cancelled) setState({ manifest: value, loading: false })
    }).catch((error: unknown) => {
      if (cancelled) return
      setState(current => ({ ...current, loading: false, error: friendlyDiffError(error) }))
    })
    return () => { cancelled = true }
  }, [baseUrl, review.repoSlug, review.number, nonce])

  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])
  return { manifest: state.manifest, loading: state.loading, error: state.error, refresh }
}

function friendlyDiffError(error: unknown): string {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return '获取 diff 超时（本地克隆首次同步可能较慢），请重试'
  }
  return error instanceof Error ? error.message : String(error)
}

export interface ReviewDiffPayloadState {
  payload?: ReviewDiffPayload
  loading: boolean
  error?: string
}

/** Plain fetch of one file's payload (shared module cache); throws on failure. */
export async function fetchReviewDiffPayload(
  baseUrl: string,
  review: ReviewRequestRecord,
  manifest: ReviewDiffManifest,
  fileIndex: number,
): Promise<ReviewDiffPayload> {
  const cacheKey = `${manifest.token}:${String(fileIndex)}`
  const cached = payloadCache.get(cacheKey)
  if (cached !== undefined) return cached
  const url = `${baseUrl}/api/reviews/${review.repoSlug}/${String(review.number)}/diff?token=${encodeURIComponent(manifest.token)}&file=${String(fileIndex)}`
  const response = await fetch(url, { cache: 'no-store' })
  const value = await response.json() as ReviewDiffPayload & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  payloadCache.set(cacheKey, value)
  return value
}

/** Fetch one file's payload by manifest token + file index, cached per file. */
export function useReviewDiffPayload(
  baseUrl: string,
  review: ReviewRequestRecord,
  manifest: ReviewDiffManifest | undefined,
  fileIndex: number | undefined,
): ReviewDiffPayloadState {
  const cacheKey = fileIndex === undefined ? undefined : `${manifest?.token ?? ''}:${String(fileIndex)}`
  const [state, setState] = useState<{ key?: string; payload?: ReviewDiffPayload; error?: string }>({
    key: cacheKey,
    payload: cacheKey === undefined ? undefined : payloadCache.get(cacheKey),
  })

  useEffect(() => {
    if (cacheKey === undefined || manifest === undefined || fileIndex === undefined) {
      setState({ key: cacheKey })
      return
    }
    const available = payloadCache.get(cacheKey)
    if (available !== undefined) {
      setState({ key: cacheKey, payload: available })
      return
    }
    const abort = new AbortController()
    setState({ key: cacheKey })
    void fetchReviewDiffPayload(baseUrl, review, manifest, fileIndex).then(value => {
      if (abort.signal.aborted) return
      setState({ key: cacheKey, payload: value })
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return
      setState({ key: cacheKey, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { abort.abort() }
  }, [baseUrl, cacheKey, fileIndex, manifest, review.repoSlug, review.number])

  return {
    payload: state.key === cacheKey ? state.payload : undefined,
    loading: state.key === cacheKey && state.payload === undefined && state.error === undefined,
    error: state.key === cacheKey ? state.error : undefined,
  }
}

export interface ReviewFileContentState {
  content?: string
  truncated: boolean
  loading: boolean
  error?: string
}

/** Fetch one changed file's full content at the PR head (continuous browsing). */
export function useReviewFileContent(
  baseUrl: string,
  review: ReviewRequestRecord,
  manifest: ReviewDiffManifest | undefined,
  path: string | undefined,
): ReviewFileContentState {
  const cacheKey = path === undefined ? undefined : `${manifest?.token ?? ''}:content:${path}`
  const [state, setState] = useState<{ key?: string; content?: string; truncated: boolean; error?: string }>({
    key: cacheKey,
    content: cacheKey === undefined ? undefined : contentCache.get(cacheKey)?.content,
    truncated: cacheKey !== undefined && (contentCache.get(cacheKey)?.truncated ?? false),
  })

  useEffect(() => {
    if (cacheKey === undefined || manifest === undefined || path === undefined) {
      setState({ key: cacheKey, truncated: false })
      return
    }
    const available = contentCache.get(cacheKey)
    if (available !== undefined) {
      setState({ key: cacheKey, content: available.content, truncated: available.truncated })
      return
    }
    const abort = new AbortController()
    setState({ key: cacheKey, truncated: false })
    const url = `${baseUrl}/api/reviews/${review.repoSlug}/${String(review.number)}/content?token=${encodeURIComponent(manifest.token)}&path=${encodeURIComponent(path)}`
    void fetch(url, { signal: abort.signal, cache: 'no-store' }).then(async response => {
      const value = await response.json() as { content?: string; truncated?: boolean; error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      if (typeof value.content !== 'string') throw new Error('content 响应无效')
      contentCache.set(cacheKey, { content: value.content, truncated: value.truncated === true })
      setState({ key: cacheKey, content: value.content, truncated: value.truncated === true })
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return
      setState({ key: cacheKey, truncated: false, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { abort.abort() }
  }, [baseUrl, cacheKey, manifest, path, review.repoSlug, review.number])

  return {
    content: state.key === cacheKey ? state.content : undefined,
    truncated: state.key === cacheKey && state.truncated,
    loading: state.key === cacheKey && state.content === undefined && state.error === undefined,
    error: state.key === cacheKey ? state.error : undefined,
  }
}
