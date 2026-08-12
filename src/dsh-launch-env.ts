import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { escapeXml } from './util.ts'

/** Harness 只允许由启动进程提供的 endpoint 变量。 */
const DSH_LAUNCH_ENV_NAMES = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_SEARCH_BASE_URL',
] as const

/** 将 dsh 启动变量渲染为 launchd EnvironmentVariables 条目。 */
export function dshLaunchEnvironmentXml(environment: NodeJS.ProcessEnv): string {
  return launchEnvironmentXml(environment)
}

/**
 * Resolve worker credentials from Harness's own user-env fallback. The daemon
 * and every session home remain isolated; only the standard dotenv values are
 * inherited, with the launching environment retaining precedence.
 */
export function dshWorkerLaunchEnvironmentXml(
  environment: NodeJS.ProcessEnv,
  userEnvFile = join(homedir(), '.dsh', '.env'),
  override: Readonly<Record<string, string | undefined>> = {},
): string {
  let fallback: NodeJS.ProcessEnv = {}
  try {
    fallback = parseEnv(readFileSync(userEnvFile, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法读取 Harness 用户环境文件 ${userEnvFile}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const combined = { ...fallback, ...environment, ...withoutUndefined(override) }
  return launchEnvironmentXml(combined, [...DSH_LAUNCH_ENV_NAMES, ...Object.keys(override)])
}

function withoutUndefined(values: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function launchEnvironmentXml(environment: NodeJS.ProcessEnv, names: readonly string[] = DSH_LAUNCH_ENV_NAMES): string {
  return [...new Set(names)].flatMap(name => {
    const value = environment[name]
    return value === undefined ? [] : [`<key>${name}</key><string>${escapeXml(value)}</string>`]
  }).join('\n    ')
}
