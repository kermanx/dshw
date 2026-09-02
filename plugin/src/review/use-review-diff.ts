/** Review diff data hooks: manifest fetch + lazy, cached per-file payloads. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewDiffManifest, ReviewDiffPayload, ReviewRequestRecord } from '../../../src/types.ts'

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

/** Fetch one file's payload by manifest token + file index, cached per file. */
export function useReviewDiffPayload(
  baseUrl: string,
  review: ReviewRequestRecord,
  manifest: ReviewDiffManifest | undefined,
  fileIndex: number | undefined,
): ReviewDiffPayloadState {
  const cacheRef = useRef(new Map<string, ReviewDiffPayload>())
  const cacheKey = fileIndex === undefined ? undefined : `${manifest?.token ?? ''}:${String(fileIndex)}`
  const [state, setState] = useState<{ key?: string; payload?: ReviewDiffPayload; error?: string }>({
    key: cacheKey,
    payload: cacheKey === undefined ? undefined : cacheRef.current.get(cacheKey),
  })

  useEffect(() => {
    if (cacheKey === undefined || manifest === undefined || fileIndex === undefined) {
      setState({ key: cacheKey })
      return
    }
    const available = cacheRef.current.get(cacheKey)
    if (available !== undefined) {
      setState({ key: cacheKey, payload: available })
      return
    }
    const abort = new AbortController()
    setState({ key: cacheKey })
    const url = `${baseUrl}/api/reviews/${review.repoSlug}/${String(review.number)}/diff?token=${encodeURIComponent(manifest.token)}&file=${String(fileIndex)}`
    void fetch(url, { signal: abort.signal, cache: 'no-store' }).then(async response => {
      const value = await response.json() as ReviewDiffPayload & { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      cacheRef.current.set(cacheKey, value)
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
