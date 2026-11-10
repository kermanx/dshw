/**
 * Pi extension that turns the review agent into a read-only reviewer.
 *
 * Ported from dsh-dev-bench (`src/support/code-review/extension.ts`) and
 * eventually from https://gitlab.deepseek.com/Ts2/cc_bot (`config/pi/extensions/git-only-bash.ts`,
 * synced at 7202626a, 2026-11-06)
 * (`config/pi/extensions/git-only-bash.ts`; path/command policy adapted from
 * `dsh-plugins/review-policy.mjs`).
 *
 * dshw does not ship this file to Pi verbatim: `extension.ts` strips the type
 * annotations with Node's `module.stripTypeScriptTypes`, inlines the validation
 * module at {@link VALIDATION_MARKER} and writes the resulting JavaScript into
 * the run directory. Keep this file free of non-erasable TypeScript (enums,
 * namespaces, parameter properties).
 *
 * Three layers of control:
 *   1. bash — one read-only git command; shell metacharacters are rejected
 *   2. edit/write — only `mr_review_result.json`
 *   3. read/grep/find/ls — confined to the review workspace (realpath checked)
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

/*__VALIDATION_SOURCE__*/

const RESULT_FILE = 'mr_review_result.json'

export default function (pi: ExtensionAPI): void {
  /** Resolve both sides: a dangling or escaping path is a rejection, never a lexical pass. */
  async function withinRepo(input: string, cwd: string): Promise<boolean> {
    try {
      const root = await realpath(cwd)
      const target = await realpath(resolve(cwd, input || '.'))
      return target === root || target.startsWith(root + sep)
    } catch {
      return false
    }
  }

  /** The result file may not exist yet, but its directory must be the repository root. */
  async function isResultFile(input: string, cwd: string): Promise<boolean> {
    if (!input) return false
    const lexical = resolve(cwd, input)
    if (basename(lexical) !== RESULT_FILE) return false
    try {
      try {
        const info = await lstat(lexical)
        if (info.isSymbolicLink() || !info.isFile()) return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      }
      return await realpath(dirname(lexical)) === await realpath(cwd)
    } catch {
      return false
    }
  }

  // `branch` and `symbolic-ref` have both read and mutation forms, so their
  // arguments are checked instead of trusting the subcommand alone.
  const readonlyGit = new Set([
    'diff', 'diff-tree', 'log', 'show', 'status', 'blame', 'describe', 'shortlog',
    'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'grep', 'name-rev',
    'show-ref', 'merge-base', 'symbolic-ref', 'whatchanged', 'branch',
  ])

  /** Parse quotes and escapes without invoking a shell, so quoted flags cannot bypass policy. */
  function shellWords(command: string): string[] | null {
    const words: string[] = []
    let word = ''
    let quote = ''
    let started = false
    for (let index = 0; index < command.length; index++) {
      const char = command[index]!
      if (char === '\\' && quote !== "'") {
        if (++index === command.length) return null
        word += command[index]
        started = true
      } else if (quote) {
        if (char === quote) quote = ''
        else word += char
      } else if (char === "'" || char === '"') {
        quote = char
        started = true
      } else if (/\s/u.test(char)) {
        if (started) {
          words.push(word)
          word = ''
          started = false
        }
      } else {
        word += char
        started = true
      }
    }
    if (quote) return null
    if (started) words.push(word)
    return words
  }

  function branchIsReadonly(args: string[]): boolean {
    let explicitList = false
    const positionals: string[] = []
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (arg === '--list') {
        explicitList = true
        continue
      }
      if (/^-[arv]+$/u.test(arg) || ['--all', '--remotes', '--verbose', '--show-current', '--no-color', '--no-abbrev', '--ignore-case'].includes(arg)) continue
      if (/^--(?:color|abbrev|sort|format|contains|no-contains|merged|no-merged|points-at)=/u.test(arg)) continue
      if (['--sort', '--format', '--points-at'].includes(arg)) {
        if (!args[index + 1] || args[index + 1]!.startsWith('-')) return false
        index++
        continue
      }
      if (['--contains', '--no-contains', '--merged', '--no-merged'].includes(arg)) {
        if (args[index + 1] && !args[index + 1]!.startsWith('-')) index++
        continue
      }
      if (arg.startsWith('-')) return false
      positionals.push(arg)
    }
    return positionals.length === 0 || explicitList
  }

  function gitCommandDenial(command: string): string | null {
    if (!command.trim()) return '空命令'
    // Check the original text, before parsing; never strip assignment prefixes.
    if (/[\r\n\0;&|<>`$(){}!*?[\]~]/u.test(command)) {
      return '禁止 shell 元字符、换行、替换、管道和重定向。每次只运行一条 git 命令。'
    }
    const words = shellWords(command)
    if (!words || words[0] !== 'git') return '仅允许 git 命令。使用 Read/Grep/Find/Ls 查看文件。'
    let index = 1
    while (words[index] === '--no-pager' || words[index] === '--no-optional-locks') index++
    const subcommand = words[index++] ?? ''
    if (!readonlyGit.has(subcommand)) return '仅允许只读 git 子命令。'
    const args = words.slice(index)
    const forbidden = args.find(arg => /^-[cC]/u.test(arg)
      || /^--(?:exec-path|config-env|git-dir|work-tree|namespace|upload-pack|receive-pack|pager|output|ext-diff|textconv|no-index|contents|filters|open-files-in-pager)(?:=|$)/u.test(arg)
      || (subcommand === 'grep' && /^-O/u.test(arg)))
    if (forbidden) return '禁止可能改配置、切换仓库、写入文件或执行外部程序的 git 选项：' + forbidden
    if (subcommand === 'branch' && !branchIsReadonly(args)) return 'git branch 只允许列出分支，不能创建、删除或修改分支。'
    if (subcommand === 'symbolic-ref') {
      const refs = args.filter(arg => !['--quiet', '-q', '--short'].includes(arg))
      if (refs.length !== 1 || refs[0]!.startsWith('-')) return 'git symbolic-ref 只允许读取一个引用。'
    }
    return null
  }

  /** Validate `mr_review_result.json`; returns the message to show the model, or null. */
  async function validateResultFile(cwd: string): Promise<string | null> {
    const filePath = resolve(cwd, RESULT_FILE)
    if (!await isResultFile(RESULT_FILE, cwd)) return '结果文件路径不合法，不能是符号链接或目录。'
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (error) {
      return '无法读取 ' + RESULT_FILE + ': ' + (error as Error).message
    }
    if (!raw.trim()) return '文件为空，需要写入合法的 JSON。'
    try {
      validateReviewResult(JSON.parse(raw))
      return null
    } catch (e) {
      return `JSON 解析失败: ${(e as Error).message}。文件已写入但格式不合法，请修正后重新写入。`
    }
  }

  // tool_call: reject anything outside the policy.
  pi.on('tool_call', async (event, ctx) => {
    const tool = event.toolName
    const cwd = ctx.cwd || process.cwd()

    if (tool === 'bash') {
      const denial = gitCommandDenial(String(event.input?.command ?? ''))
      return denial ? { block: true, reason: denial } : undefined
    }

    if (tool === 'edit' || tool === 'write') {
      const filePath = String(event.input?.path ?? '')
      if (!await isResultFile(filePath, cwd)) return { block: true, reason: '仅允许写入 mr_review_result.json。' }
      return
    }

    if (tool === 'read') {
      const filePath = String(event.input?.path ?? '')
      if (!await withinRepo(filePath, cwd)) return { block: true, reason: '仅允许读取仓库目录内的文件。' }
      return
    }

    if (tool === 'grep' || tool === 'find' || tool === 'ls') {
      const dir = String(event.input?.path ?? '')
      if (!await withinRepo(dir, cwd)) return { block: true, reason: '仅允许在仓库目录内操作。' }
      return
    }
  })

  // tool_result: validate the delivered result file and tell the model about it.
  // `resultValid` is the single in-process flag agent_end reads, so delivery is
  // judged without touching the disk again.
  let resultValid = false
  let lastValidationError = ''
  pi.on('tool_result', async (event, ctx) => {
    const tool = event.toolName
    if (tool !== 'write' && tool !== 'edit') return

    const cwd = ctx.cwd || process.cwd()
    const filePath = String(event.input?.path ?? '')
    if (!filePath || (resolve(cwd, filePath) !== resolve(cwd, RESULT_FILE) && !await isResultFile(filePath, cwd))) return
    const error = event.isError === true
      ? '写入工具报错，未完成交付（结果文件未更新）。'
      : await validateResultFile(cwd)
    const existing = event.content || []
    if (error) {
      resultValid = false
      lastValidationError = error
      return { content: [...existing, { type: 'text', text: `\n\n⚠️ JSON 验证失败: ${error}` }] }
    }
    resultValid = true
    lastValidationError = ''
    return { content: [...existing, { type: 'text', text: '\n\n✅ JSON 格式验证通过。审查完成。' }] }
  })

  // agent_end is the non-interactive exit hook: a reasoning model that prints
  // the review instead of writing the file is nudged back, a bounded number of
  // times, so a run can never loop forever.
  let writeNudges = 0
  const MAX_WRITE_NUDGES = 3
  pi.on('agent_end', async () => {
    if (resultValid) return
    if (writeNudges >= MAX_WRITE_NUDGES) return
    writeNudges++
    pi.sendUserMessage(
      '你还没有通过 Write 工具写入合法的 mr_review_result.json——这是交付审查结果的'
        + '唯一方式，输出到对话中的任何内容都会被丢弃。'
        + (lastValidationError ? `当前问题：${lastValidationError} ` : '')
        + '请立即调用 Write 工具，把包含 summary 和 comments 的完整审查结果 JSON 写入 '
        + 'mr_review_result.json；不要提问、不要等待确认。',
      // The agent is still processing at agent_end, so this must be queued as
      // a follow-up; it starts the next run even under `--print`.
      { deliverAs: 'followUp' },
    )
  })
}
