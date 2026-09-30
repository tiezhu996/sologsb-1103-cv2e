import type { LogEntryKind } from '@/types/recon'

/**
 * 控台日志行解析。常见控台（ETC Eos、MA、国产品牌等）导出格式不一，
 * 这里对「行首时间戳 + 正文」做宽松识别：
 * - 完整日期时间：`2026-09-30 19:32:05`、`[2026/09/30 19:32:05.1]`
 * - 仅时刻：`19:32:05`、`[19:32]`（日期取导入任务记录的演出日期）
 * - 正文里识别 Cue 编号（Q12 / Q12.5 / Cue 12）与触发动作
 */

const FULL_DATETIME_RE =
  /^\s*\[?\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?\]?/
const TIME_ONLY_RE = /^\s*\[?\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?\]?/

/** 正文里的 Cue 编号：Q12 / q12.5 / Cue 12 / CUE.12 */
const CUE_TOKEN_RE = /(?:Q\s*|CUE\.?\s*)(\d+(?:\.\d+)?)/i

/** 无编号时判定为「触发类」动作的关键词 */
const ACTION_RE =
  /\b(?:go|manual|override|bump|exec|execute)\b|执行|触发|手动|手推|补点|切入|切出|推上|拉掉|收掉|加光|收光/i

/** 注释 / 空行 */
const COMMENT_RE = /^\s*(?:#|\/\/|;)/

/** 单行解析结果（id / importId / seq 由导入流程补） */
export interface ParsedLogLine {
  time: number | null
  timeText: string
  kind: LogEntryKind
  cueNo: string | null
  text: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 毫秒片段（`.1` / `,120`）转毫秒数 */
function fractionToMs(raw: string | undefined): number {
  if (!raw) return 0
  const normalized = raw.padEnd(3, '0').slice(0, 3)
  return Number.parseInt(normalized, 10)
}

/** 去掉行首时间戳后剩余的正文 */
function splitTimestamp(raw: string, baseDateMs: number): { time: number | null; timeText: string; rest: string } | null {
  const full = FULL_DATETIME_RE.exec(raw)
  if (full) {
    const year = Number(full[1])
    const month = Number(full[2])
    const day = Number(full[3])
    const hour = Number(full[4])
    const minute = Number(full[5])
    const second = full[6] ? Number(full[6]) : 0
    const ms = fractionToMs(full[7])
    const date = new Date(year, month - 1, day, hour, minute, second, ms)
    return {
      time: date.getTime(),
      timeText: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
      rest: raw.slice(full[0].length)
    }
  }

  const only = TIME_ONLY_RE.exec(raw)
  if (only) {
    const hour = Number(only[1])
    const minute = Number(only[2])
    const second = only[3] ? Number(only[3]) : 0
    const ms = fractionToMs(only[4])
    const time = new Date(baseDateMs).setHours(hour, minute, second, ms)
    return {
      time,
      timeText: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
      rest: raw.slice(only[0].length)
    }
  }

  return null
}

/** 从正文里摘出 Cue 编号并返回归一化编号与去掉编号后的文本 */
function extractCueNo(rest: string): { cueNo: string | null; text: string } {
  const matched = CUE_TOKEN_RE.exec(rest)
  if (!matched) return { cueNo: null, text: rest.trim() }
  const cueNo = `Q${matched[1]}`
  const text = rest.replace(matched[0], ' ').replace(/\s+/g, ' ').trim()
  return { cueNo, text }
}

/**
 * 解析一行日志。空行 / 注释行返回 null（跳过，不计序号）。
 * 行内没有时间戳也能解析：time 为 null，正文仍可在原始日志栏查看，
 * 但不参与触发配对与缺段判定。
 */
export function parseLogLine(raw: string, baseDateMs: number): ParsedLogLine | null {
  const line = raw.replace(/\r?\n$/, '').trim()
  if (!line || COMMENT_RE.test(line)) return null

  const split = splitTimestamp(line, baseDateMs)
  const time = split?.time ?? null
  const timeText = split?.timeText ?? ''
  const body = (split?.rest ?? line).replace(/^[\s\]|\-:：]+/, '').trim()

  const { cueNo, text } = extractCueNo(body)
  let kind: LogEntryKind
  if (cueNo) {
    kind = 'cue'
  } else if (ACTION_RE.test(body)) {
    kind = 'manual'
  } else {
    kind = 'info'
  }

  return { time, timeText, kind, cueNo, text: text || body }
}

/** 解析一批文本，按换行切分；chunk 末尾不完整的半行通过 carry 跨批拼接 */
export interface ParsedBatch {
  /** 完整解析出的行（不含 chunk 末尾半行） */
  lines: ParsedLogLine[]
  /** 这些完整行（含末尾换行）在 UTF-8 下占用的字节数，用作断点偏移 */
  consumedBytes: number
  /** chunk 末尾未结束的半行，下次拼接 */
  carry: string
}

const encoder = new TextEncoder()

export function parseLogChunk(chunk: string, carry: string, baseDateMs: number): ParsedBatch {
  const merged = carry + chunk
  const lastNewline = merged.lastIndexOf('\n')
  const completed = lastNewline >= 0 ? merged.slice(0, lastNewline + 1) : ''
  const nextCarry = lastNewline >= 0 ? merged.slice(lastNewline + 1) : merged

  const lines: ParsedLogLine[] = []
  if (completed) {
    const rawLines = completed.split('\n')
    // split 末尾恒为空串（completed 以 \n 结尾）
    for (let i = 0; i < rawLines.length - 1; i += 1) {
      const parsed = parseLogLine(rawLines[i], baseDateMs)
      if (parsed) lines.push(parsed)
    }
  }

  return {
    lines,
    consumedBytes: completed ? encoder.encode(completed).byteLength : 0,
    carry: nextCarry
  }
}

/** 全部字节读完后冲刷最后的半行 */
export function flushCarry(carry: string, baseDateMs: number): ParsedLogLine | null {
  if (!carry.trim()) return null
  return parseLogLine(carry, baseDateMs)
}

/** 由 `YYYY-MM-DD` 取当天 0 点毫秒；失败回退到今天 */
export function resolveLogDateMs(logDate: string): number {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(logDate)
  if (!matched) {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
  return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime()
}

/** 今天的 `YYYY-MM-DD` */
export function todayLogDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}
