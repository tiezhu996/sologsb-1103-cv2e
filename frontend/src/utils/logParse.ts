import type { LogTriggerKind } from '@/types/log'
import { normalizeCueNo, CUE_NO_PATTERN } from '@/utils/cueOrder'

/** 解析出的单行结构（可能无法识别） */
export interface ParsedLogLine {
  lineNo: number
  raw: string
  timeOfDayMs: number | null
  rawTimestamp: string
  cueNo: string
  triggerKind: LogTriggerKind
  message: string
  /** trigger：灯光触发；info：系统信息 / 电平记录；null：无法识别 */
  recognized: 'trigger' | 'info' | null
}

const TIME_PATTERNS: RegExp[] = [
  /(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?/,
  /(\d{1,2})(\d{2})(\d{2})(?![\d:])/
]

/** GO / 执行 / 触发 / 手动 等动作词 → 触发类型 */
const TRIGGER_TOKENS: ReadonlyArray<{ pattern: RegExp; kind: LogTriggerKind }> = [
  { pattern: /(?:^|[\s【\[])(?:手动|手控|人工|manual|override)/i, kind: 'manual' },
  { pattern: /(?:^|[\s【\[])(?:自动|跟随|序列|macro|auto(?:matic)?|follow)/i, kind: 'auto' },
  { pattern: /(?:GO|执行|触发|开演|cue\s*(?:go|fire)|fire)/i, kind: 'go' }
]

/** 系统信息词：电平 / 连接 / 心跳 / 宏，不参与对账 */
const INFO_PATTERN =
  /(?:电平|通道输出|DMX|连接|断开|心跳|同步|保存|宏|macro|启动|关机|警告|故障|备份|恢复|网络|心跳|heartbeat|connect|disconnect|backup|level)/i

/** 从文本中提取 HH:mm[:ss[.mmm]]，返回当天毫秒数与原文 */
export function extractTimeOfDay(text: string): { ms: number | null; raw: string } {
  for (const pattern of TIME_PATTERNS) {
    const match = text.match(pattern)
    if (!match) continue
    const hour = Number.parseInt(match[1], 10)
    const minute = Number.parseInt(match[2], 10)
    const second = match[3] !== undefined ? Number.parseInt(match[3], 10) : 0
    if (hour > 23 || minute > 59 || second > 59) continue
    return {
      ms: hour * 3_600_000 + minute * 60_000 + second * 1000,
      raw: match[0]
    }
  }
  return { ms: null, raw: '' }
}

/** 提取消息中的 Cue 编号，兼容 `Q12`、`Cue 12.5`、`【Q3】` */
export function extractCueNo(text: string): string {
  const match = text.match(/(?:Q|Cue[_\s-]*)\s*(\d+(?:\.\d+)?)/i)
  if (!match) return ''
  const normalized = normalizeCueNo(`Q${match[1]}`)
  return CUE_NO_PATTERN.test(normalized) ? normalized : ''
}

function detectTriggerKind(text: string): LogTriggerKind {
  for (const token of TRIGGER_TOKENS) {
    if (token.pattern.test(text)) return token.kind
  }
  return 'unknown'
}

/** 去掉时间戳、级别标签、编号、动作词，得到提示语近似文本 */
function stripToMessage(line: string, timeRaw: string, cueNo: string): string {
  let message = line.trim()
  if (timeRaw) message = message.replace(timeRaw, ' ')
  message = message.replace(/^\s*[\d-/.]+\s+/, '')
  message = message.replace(/[[【(（][^\]】)）]*[\]】)）]/g, ' ')
  message = message.replace(/\b(?:INFO|WARN|WARNING|ERROR|DEBUG|NOTICE|TRACE)\b/gi, ' ')
  if (cueNo) {
    message = message.replace(new RegExp(`(?:Q|Cue[\\s_-]*)\\s*${cueNo.slice(1)}`, 'gi'), ' ')
  }
  message = message.replace(/\b(?:GO|执行|触发|开演|手动|手控|人工|自动|跟随|manual|auto(?:matic)?|follow|fire|override)\b/gi, ' ')
  return message.replace(/[\s,，:：|｜-]+/g, ' ').trim()
}

/**
 * 解析单行灯控台日志。
 * 识别优先级：有时间戳且含动作词或 Cue 编号 → trigger；含系统信息词 → info；
 * 无时间戳但含编号 + 动作词 → trigger；其余 → null（无法识别）。
 */
export function parseLogLine(lineNo: number, rawLine: string): ParsedLogLine {
  const raw = rawLine.replace(/\r$/, '')
  const trimmed = raw.trim()
  const fallback: ParsedLogLine = {
    lineNo,
    raw,
    timeOfDayMs: null,
    rawTimestamp: '',
    cueNo: '',
    triggerKind: 'unknown',
    message: '',
    recognized: null
  }
  if (!trimmed) return fallback

  const { ms, raw: rawTimestamp } = extractTimeOfDay(trimmed)
  const cueNo = extractCueNo(trimmed)
  const hasActionWord = /(?:GO|执行|触发|开演|手动|手控|人工|自动|跟随|manual|auto(?:matic)?|follow|fire|override)/i.test(trimmed)

  if (ms === null && !(cueNo && hasActionWord)) {
    return { ...fallback, raw }
  }

  if (!hasActionWord && INFO_PATTERN.test(trimmed)) {
    return {
      lineNo,
      raw,
      timeOfDayMs: ms,
      rawTimestamp,
      cueNo,
      triggerKind: 'unknown',
      message: stripToMessage(trimmed, rawTimestamp, cueNo),
      recognized: 'info'
    }
  }

  if (!hasActionWord && !cueNo) {
    return {
      lineNo,
      raw,
      timeOfDayMs: ms,
      rawTimestamp,
      cueNo: '',
      triggerKind: 'unknown',
      message: stripToMessage(trimmed, rawTimestamp, ''),
      recognized: 'info'
    }
  }

  return {
    lineNo,
    raw,
    timeOfDayMs: ms,
    rawTimestamp,
    cueNo,
    triggerKind: detectTriggerKind(trimmed),
    message: stripToMessage(trimmed, rawTimestamp, cueNo),
    recognized: 'trigger'
  }
}


export interface ParseBatchContext {
  startLineNo: number
  /** 时间戳 → 首个触发行号，跨批次检测重复时间戳 */
  seenTimestamps: Map<number, number>
}

export interface ParseSummary {
  entries: Array<Omit<import('@/types/log').ConsoleLogEntry, 'id' | 'logId' | 'sessionId'>>
  infoCount: number
  malformedCount: number
  /** 系统信息行号（供断点续传按行号去重计数） */
  infoLineNos: number[]
  /** 无法识别行号（供断点续传按行号去重计数） */
  malformedLineNos: number[]
  malformedSamples: string[]
  /** 本批次发现的重复时间戳行号（含此前批次首条行号） */
  duplicateLineNos: Set<number>
  /** 本批最后一条源行的行号（末行含空行）；下一批 startLineNo 用 endLineNo + 1 */
  endLineNo: number
}

/** 批量解析若干文本行，按断点上下文延续行号与重复时间戳检测 */
export function parseLogLines(lines: readonly string[], context: ParseBatchContext): ParseSummary {
  const entries: ParseSummary['entries'] = []
  const malformedSamples: string[] = []
  const infoLineNos: number[] = []
  const malformedLineNos: number[] = []
  const duplicateLineNos = new Set<number>()

  lines.forEach((line, index) => {
    const lineNo = context.startLineNo + index
    const parsed = parseLogLine(lineNo, line)
    if (parsed.recognized === 'info') {
      infoLineNos.push(lineNo)
      return
    }
    if (parsed.recognized === null) {
      if (parsed.raw.trim()) {
        malformedLineNos.push(lineNo)
        if (malformedSamples.length < 5) malformedSamples.push(parsed.raw.slice(0, 120))
      }
      return
    }
    let dupTimestamp = false
    if (parsed.timeOfDayMs !== null) {
      const prevLineNo = context.seenTimestamps.get(parsed.timeOfDayMs)
      if (prevLineNo !== undefined) {
        dupTimestamp = true
        duplicateLineNos.add(prevLineNo)
        duplicateLineNos.add(lineNo)
      } else {
        context.seenTimestamps.set(parsed.timeOfDayMs, lineNo)
      }
    }
    entries.push({
      lineNo,
      timeOfDayMs: parsed.timeOfDayMs,
      rawTimestamp: parsed.rawTimestamp,
      cueNo: parsed.cueNo,
      kind: 'trigger',
      triggerKind: parsed.triggerKind,
      message: parsed.message,
      raw: parsed.raw.slice(0, 240),
      dupTimestamp
    })
  })

  return {
    entries,
    infoCount: infoLineNos.length,
    malformedCount: malformedLineNos.length,
    infoLineNos,
    malformedLineNos,
    malformedSamples,
    duplicateLineNos,
    endLineNo: lines.length === 0 ? context.startLineNo - 1 : context.startLineNo + lines.length - 1
  }
}
