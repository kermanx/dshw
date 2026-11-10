/**
 * Rough price table for review models, in USD per million tokens.
 *
 * The gateway does not expose pricing, so the number shown in Feishu is an
 * estimate from this table. Users can override it in the settings panel; the
 * card always labels the value as an estimate.
 */
import type { ReviewPricing, ReviewUsage } from './engine.ts'

interface PriceRule {
  match: RegExp
  input: number
  output: number
}

const RULES: readonly PriceRule[] = [
  { match: /claude-opus/iu, input: 15, output: 75 },
  { match: /claude-fable/iu, input: 15, output: 75 },
  { match: /claude-haiku/iu, input: 1, output: 5 },
  { match: /claude/iu, input: 3, output: 15 },
  { match: /deepseek-v4-pro/iu, input: 0.55, output: 2.19 },
  { match: /deepseek/iu, input: 0.28, output: 0.42 },
  { match: /glm/iu, input: 0.6, output: 2.2 },
  { match: /gemini/iu, input: 1.25, output: 10 },
  { match: /gpt-6/iu, input: 2.5, output: 10 },
  { match: /gpt/iu, input: 2.5, output: 10 },
]

/** Estimated prices for a model id (USD per 1M tokens). */
export function estimatePricing(model: string): ReviewPricing {
  return RULES.find(rule => rule.match.test(model)) ?? { input: 1, output: 3 }
}

/** Short token count: 12.7k / 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/** The cost line shown at the bottom of the findings panel. */
export function formatCost(usage: ReviewUsage): string {
  const cost = usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)
  const parts = [`≈ $${cost}（估价）`, `${formatTokens(usage.input)} 输入 / ${formatTokens(usage.output)} 输出`]
  if (usage.cacheRead > 0) parts.push(`${formatTokens(usage.cacheRead)} 命中缓存`)
  parts.push(`${String(usage.steps)} 步`)
  return `本次评审开销：${parts.join(' · ')}`
}
