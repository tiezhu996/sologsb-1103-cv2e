import type { Cue } from '@/types/cue'
import type { ConsoleLogEntry } from '@/types/log'
import type {
  MatchCandidate,
  MatchedPair,
  ReconcileReport,
  UnmatchedCue,
  UnmatchedLog
} from '@/types/reconcile'
import { cueTotalSeconds, round1 } from '@/utils/fade'
import { createId } from '@/utils/id'

/** 自动确认的把握度阈值 */
const CONFIRM_SCORE = 70
/** 提示语强相似阈值（仅靠提示语 + 顺序也可确认） */
const STRONG_LABEL = 0.72
/** 候选保留条数（每侧） */
const CANDIDATE_LIMIT = 5
/** 触发顺序的有效对齐带宽（位次差超过此值不再给顺序分） */
const ORDER_BAND = 8

/** HH:mm → 当天毫秒 */
export function hhmmToMs(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?:\D(\d{2}))?/.exec(hhmm.trim())
  if (!match) return null
  const hour = Number.parseInt(match[1], 10)
  const minute = Number.parseInt(match[2], 10)
  if (hour > 23 || minute > 59) return null
  return hour * 3_600_000 + minute * 60_000
}

/** 当天毫秒 → HH:mm:ss（秒可选） */
export function msToClock(ms: number, withSeconds = true): string {
  const wrapped = ((ms % 86_400_000) + 86_400_000) % 86_400_000
  const hour = Math.floor(wrapped / 3_600_000)
  const minute = Math.floor((wrapped % 3_600_000) / 60_000)
  const second = Math.floor((wrapped % 60_000) / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return withSeconds ? `${pad(hour)}:${pad(minute)}:${pad(second)}` : `${pad(hour)}:${pad(minute)}`
}

/** 跨零点的两时刻差（秒），结果收敛到 ±12 小时内 */
export function deviationSeconds(actualMs: number | null, plannedMs: number | null): number | null {
  if (actualMs === null || plannedMs === null) return null
  let diff = (actualMs - plannedMs) / 1000
  while (diff > 43_200) diff -= 86_400
  while (diff < -43_200) diff += 86_400
  return round1(diff)
}

/** 中文友好的偏差文本：`+12.5s` / `-1m03s` */
export function formatDeviation(sec: number | null): string {
  if (sec === null) return '—'
  const sign = sec > 0 ? '+' : sec < 0 ? '-' : '±'
  const abs = Math.abs(sec)
  if (abs >= 60) {
    const minutes = Math.floor(abs / 60)
    const rest = Math.round(abs - minutes * 60)
    return `${sign}${minutes}m${String(rest).padStart(2, '0')}s`
  }
  return `${sign}${round1(abs)}s`
}

/** 归一化提示语：去空白与标点、统一小写 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 字符二元组 Dice 相似度（对中文短提示语较稳健） */
export function labelSimilarity(a: string, b: string): number {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) {
    return Math.min(1, (Math.min(left.length, right.length) / Math.max(left.length, right.length)) * 0.9 + 0.1)
  }
  const bigrams = (text: string): Map<string, number> => {
    const map = new Map<string, number>()
    for (let i = 0; i < text.length - 1; i += 1) {
      const gram = text.slice(i, i + 2)
      map.set(gram, (map.get(gram) ?? 0) + 1)
    }
    return map
  }
  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  let overlap = 0
  leftGrams.forEach((count, gram) => {
    overlap += Math.min(count, rightGrams.get(gram) ?? 0)
  })
  const total = left.length - 1 + (right.length - 1)
  return total <= 0 ? 0 : (2 * overlap) / total
}

interface CueNode {
  cue: Cue
  order: number
  plannedMs: number | null
}

/** 按场次计划开场 + 各 Cue 过渡时长推估每条 Cue 的计划触发时刻 */
export function buildPlannedMap(orderedCues: readonly Cue[], plannedStart: string | null): Map<string, number | null> {
  const startMs = plannedStart ? hhmmToMs(plannedStart) : null
  const map = new Map<string, number | null>()
  let elapsedSec = 0
  orderedCues.forEach((cue) => {
    map.set(cue.id, startMs === null ? null : startMs + elapsedSec * 1000)
    elapsedSec += cueTotalSeconds(cue)
  })
  return map
}

interface Edge {
  cueIndex: number
  entryIndex: number
  score: number
  cueNoHit: boolean
  labelSim: number
  orderDistance: number
  deviationSec: number | null
  reasons: Array<MatchCandidate['reasons'][number]>
}

/** 评分：编号 60 + 提示语 24 + 触发顺序 24 + 时刻吻合 16（满分上限 100） */
function scoreEdge(cueNode: CueNode, entry: ConsoleLogEntry, entryRank: number): Edge {
  const reasons: Edge['reasons'] = []
  const cueNoHit = entry.cueNo !== '' && entry.cueNo === cueNode.cue.cueNo
  if (cueNoHit) reasons.push('cueNo')

  const labelSim = labelSimilarity(cueNode.cue.label, entry.message)
  if (labelSim >= 0.4) reasons.push('label')

  const orderDistance = Math.abs(cueNode.order - entryRank)
  if (orderDistance <= 2) reasons.push('sequence')

  const deviationSec = deviationSeconds(entry.timeOfDayMs, cueNode.plannedMs)
  let timeScore = 0
  if (deviationSec !== null) {
    const abs = Math.abs(deviationSec)
    if (abs <= 30) timeScore = 16
    else if (abs <= 120) timeScore = 10
    else if (abs <= 600) timeScore = 5
  }

  const orderScore = Math.max(0, ORDER_BAND - orderDistance) * 3
  const score = Math.min(
    100,
    (cueNoHit ? 60 : 0) + Math.round(labelSim * 24) + orderScore + timeScore
  )

  return {
    cueIndex: -1,
    entryIndex: -1,
    score,
    cueNoHit,
    labelSim,
    orderDistance,
    deviationSec,
    reasons
  }
}

function isConfident(edge: Edge): boolean {
  if (edge.score < CONFIRM_SCORE) return false
  if (edge.cueNoHit) return true
  // 无编号命中时（典型为手动补点），必须提示语强相似且顺序基本对齐
  return edge.labelSim >= STRONG_LABEL && edge.orderDistance <= 2
}

export interface ReconcileOptions {
  sessionId: string
  logId: string
  /** 场次计划开场 HH:mm，用于推估计划时刻；缺省为 null */
  plannedStart?: string | null
  /** 每枚举一批边后让出主线程的钩子（长日志防卡顿） */
  shouldYield?: (edgeCount: number) => Promise<void> | void
}

/**
 * 对账主流程：
 * 1. 枚举所有 Cue × 日志条目边并打分（编号 / 提示语 / 触发顺序 / 时刻）
 * 2. 按分数降序贪心占用，保证两侧唯一
 * 3. 高置信边自动确认，其余拆成未配对 + 候选清单
 *
 * 枚举分批执行并通过 shouldYield 让出主线程，避免长日志冻结页面。
 */
export async function reconcile(
  orderedCues: readonly Cue[],
  entries: readonly ConsoleLogEntry[],
  options: ReconcileOptions
): Promise<ReconcileReport> {
  const orderedEntries = [...entries].sort((a, b) => a.lineNo - b.lineNo)
  // 触发序号（秩）：按源行号排序后的 1 基序号，作为触发顺序对账依据
  const triggerRank = new Map<string, number>()
  orderedEntries.forEach((entry, index) => triggerRank.set(entry.id, index + 1))
  const rankOf = (entry: ConsoleLogEntry): number => triggerRank.get(entry.id) ?? 0
  const plannedMap = buildPlannedMap(orderedCues, options.plannedStart ?? null)
  const cueNodes: CueNode[] = orderedCues.map((cue, index) => ({
    cue,
    order: index + 1,
    plannedMs: plannedMap.get(cue.id) ?? null
  }))

  const allEdges: Edge[] = []
  let edgeCount = 0
  for (let cueIndex = 0; cueIndex < cueNodes.length; cueIndex += 1) {
    const node = cueNodes[cueIndex]
    for (let entryIndex = 0; entryIndex < orderedEntries.length; entryIndex += 1) {
      const entry = orderedEntries[entryIndex]
      const edge = scoreEdge(node, entry, rankOf(entry))
      edge.cueIndex = cueIndex
      edge.entryIndex = entryIndex
      // 编号都明确但不同号，且顺序差太远，直接剪枝
      if (!(entry.cueNo !== '' && !edge.cueNoHit && edge.orderDistance > ORDER_BAND) && edge.score > 0) {
        allEdges.push(edge)
      }
      edgeCount += 1
      if (options.shouldYield && edgeCount % 4000 === 0) {
        await options.shouldYield(edgeCount)
      }
    }
  }
  await options.shouldYield?.(edgeCount)

  const sortedEdges = allEdges.sort((a, b) => b.score - a.score || a.orderDistance - b.orderDistance)
  const takenCues = new Set<number>()
  const takenEntries = new Set<number>()
  const chosen = new Map<string, Edge>()
  sortedEdges.forEach((edge) => {
    if (takenCues.has(edge.cueIndex) || takenEntries.has(edge.entryIndex)) return
    takenCues.add(edge.cueIndex)
    takenEntries.add(edge.entryIndex)
    chosen.set(`${edge.cueIndex}:${edge.entryIndex}`, edge)
  })

  const pairs: MatchedPair[] = []
  const confirmedCueIndexes = new Set<number>()
  const confirmedEntryIndexes = new Set<number>()

  chosen.forEach((edge) => {
    if (!isConfident(edge)) return
    const node = cueNodes[edge.cueIndex]
    const entry = orderedEntries[edge.entryIndex]
    confirmedCueIndexes.add(edge.cueIndex)
    confirmedEntryIndexes.add(edge.entryIndex)
    pairs.push({
      cueId: node.cue.id,
      entryId: entry.id,
      cueNo: node.cue.cueNo,
      label: node.cue.label,
      trigger: node.cue.trigger,
      cueOrder: node.order,
      logSeq: rankOf(entry),
      plannedTime: node.plannedMs === null ? null : msToClock(node.plannedMs, false),
      actualTime: entry.timeOfDayMs === null ? null : msToClock(entry.timeOfDayMs),
      deviationSec: edge.deviationSec,
      score: edge.score,
      reasons: edge.reasons,
      logKind: entry.triggerKind,
      logMessage: entry.message
    })
  })
  pairs.sort((a, b) => a.cueOrder - b.cueOrder)

  const candidates: MatchCandidate[] = sortedEdges
    .filter((edge) => edge.score >= 25)
    .map((edge) => {
      const node = cueNodes[edge.cueIndex]
      const entry = orderedEntries[edge.entryIndex]
      return {
        cueId: node.cue.id,
        entryId: entry.id,
        cueNo: node.cue.cueNo,
        score: edge.score,
        cueNoHit: edge.cueNoHit,
        labelSimilarity: round1(edge.labelSim),
        orderDistance: edge.orderDistance,
        deviationSec: edge.deviationSec,
        reasons: edge.reasons,
        logCueNo: entry.cueNo,
        logSeq: rankOf(entry),
        actualTime: entry.timeOfDayMs === null ? null : msToClock(entry.timeOfDayMs),
        logMessage: entry.message,
        logKind: entry.triggerKind
      }
    })

  const candidatesOfCue = (cueIndex: number): MatchCandidate[] =>
    candidates
      .filter((candidate) => candidate.cueId === cueNodes[cueIndex].cue.id)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATE_LIMIT)

  const candidatesOfEntry = (entryIndex: number): MatchCandidate[] =>
    candidates
      .filter((candidate) => candidate.entryId === orderedEntries[entryIndex].id)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATE_LIMIT)

  const unmatchedCues: UnmatchedCue[] = []
  cueNodes.forEach((node, cueIndex) => {
    if (confirmedCueIndexes.has(cueIndex)) return
    unmatchedCues.push({
      cueId: node.cue.id,
      cueNo: node.cue.cueNo,
      label: node.cue.label,
      trigger: node.cue.trigger,
      cueOrder: node.order,
      plannedTime: node.plannedMs === null ? null : msToClock(node.plannedMs, false),
      candidateEntryIds: candidatesOfCue(cueIndex).map((candidate) => candidate.entryId)
    })
  })

  const unmatchedLogs: UnmatchedLog[] = []
  orderedEntries.forEach((entry, entryIndex) => {
    if (confirmedEntryIndexes.has(entryIndex)) return
    unmatchedLogs.push({
      entryId: entry.id,
      logSeq: rankOf(entry),
      cueNo: entry.cueNo,
      actualTime: entry.timeOfDayMs === null ? null : msToClock(entry.timeOfDayMs),
      triggerKind: entry.triggerKind,
      message: entry.message,
      lineNo: entry.lineNo,
      candidateCueIds: candidatesOfEntry(entryIndex).map((candidate) => candidate.cueId)
    })
  })

  return {
    id: createId('rpt'),
    sessionId: options.sessionId,
    logId: options.logId,
    createdAt: new Date().toISOString(),
    cueCount: cueNodes.length,
    logCount: orderedEntries.length,
    pairs,
    unmatchedCues,
    unmatchedLogs,
    candidates
  }
}

/** 报告层面的偏差汇总 */
export function deviationSummary(pairs: readonly MatchedPair[]): {
  early: number
  late: number
  onTime: number
  maxAbsSec: number
  avgAbsSec: number
} {
  let early = 0
  let late = 0
  let onTime = 0
  let maxAbsSec = 0
  let sumAbsSec = 0
  let measured = 0
  pairs.forEach((pair) => {
    if (pair.deviationSec === null) return
    measured += 1
    const abs = Math.abs(pair.deviationSec)
    maxAbsSec = Math.max(maxAbsSec, abs)
    sumAbsSec += abs
    if (abs <= 2) onTime += 1
    else if (pair.deviationSec < 0) early += 1
    else late += 1
  })
  return {
    early,
    late,
    onTime,
    maxAbsSec: round1(maxAbsSec),
    avgAbsSec: measured === 0 ? 0 : round1(sumAbsSec / measured)
  }
}
