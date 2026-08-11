import { escapeXml } from './util.ts'

/** Harness 只允许由启动进程提供的 endpoint 变量。 */
const DSH_LAUNCH_ENV_NAMES = [
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_SEARCH_BASE_URL',
] as const

/** 将 dsh 启动变量渲染为 launchd EnvironmentVariables 条目。 */
export function dshLaunchEnvironmentXml(environment: NodeJS.ProcessEnv): string {
  return DSH_LAUNCH_ENV_NAMES.flatMap(name => {
    const value = environment[name]
    return value === undefined ? [] : [`<key>${name}</key><string>${escapeXml(value)}</string>`]
  }).join('\n    ')
}
