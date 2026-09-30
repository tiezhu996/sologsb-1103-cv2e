import type { Cue } from '@/types/cue'
import type { ConsoleLogEntry, ReconCandidate, ReconExtraLog, ReconGap, ReconPair, ReconReport, ReconStats } from '@/types/recon'
import { normalizeCueNo } from '@/utils/cueOrder'
import { cueTotalSeconds, round1 } from '@/utils/fade'

/**
 * 日志与 Cue 表的对账算法（纯函数，分批 await 由 store 调度，不在此处持锁）。
 *
 * 配对优先级：
 *   1. Cue 编号直接命中（演员抢台词时编号仍最可靠）
 *   2. 剩余未配对条目做带约束的顺序对齐（触发顺序单调，不允许交叉），
 *      对齐收益由提示语相似度决定
 *   3. 仍配不准的：Cue 侧给出相似度候选，日志侧进「未对上日志」栏
 */

/** 参与配对的轻量日志结构（从 ConsoleLogEntry 投影） */
export interface ReconEntry {
  id: string
  seq: number
  time: number | null
  kind: ConsoleLogEntry['kind']
  cueNo: string | null
  text: string
  duplicateTime: boolean
}

/** 自动确认配对的相似度门槛 */
const AUTO_SIMILARITY = 0.55
/** 进入候选的相似度门槛 */
const CANDIDATE_SIMILARITY = 0.28
/** 候选上限 */
const MAX_CANDIDATES = 3
/** 顺序对齐允许的位次偏移带宽（防止抢台词 / 补点导致的整体错位） */
const ALIGN_BAND = 6

const ACTION_VERB_RE =
  /^(执行|触发|手动|手推|补点|切入|切出|推上|拉掉|收掉|加光|收光|go|cue|q|manual|execute|exec|bump|override|fader)?[\s:：-]*/i

/** 提示语归一化：去空白标点、循环剥离前导动作词与编号，便于比对控台日志正文 */
export function normalizeLabel(input: string): string {
  let s = input
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/(?:q\s*|cue\.?\s*)\d+(?:\.\d+)?/gi, ' ')
    .replace(/[\s\p{P}]/gu, '')
  // 「手动 bump 追光」→「追光」：前导动作词可能连用，循环剥掉
  let previous: string
  do {
    previous = s
    s = s.replace(ACTION_VERB_RE, '')
  } while (s !== previous && s.length > 0)
  return s
}

/** bigram Dice 系数，短串被较长串完整包含时酌情加分 */
export function labelSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeLabel(aRaw)
  const b = normalizeLabel(bRaw)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length === 1 || b.length === 1) return a === b ? 0.7 : 0

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const sa = bigrams(a)
  const sb = bigrams(b)
  let overlap = 0
  sa.forEach((token) => {
    if (sb.has(token)) overlap += 1
  })
  const dice = overlap === 0 ? 0 : (2 * overlap) / (sa.size + sb.size)

  // 完整包含：较长串至少 4 字且短串不短于 3 字时才给包含加分，
  // 避免「追光」之类 2 字公共词尾把不相关条目抬成自动配对
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length)
    const longer = Math.max(a.length, b.length)
    if (shorter >= 3 && longer >= 4) return Math.max(0.72, shorter / longer)
  }
  return dice
}

/** 解析场次的 `HH:mm` 计划时刻为毫秒（取日志演出日期当天） */
export function parseClockAt(clock: string, baseDateMs: number): number | null {
  const matched = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock.trim())
  if (!matched) return null
  const base = new Date(baseDateMs)
  base.setHours(Number(matched[1]), Number(matched[2]), matched[3] ? Number(matched[3]) : 0, 0)
  return base.getTime()
}

/** 毫秒 → `HH:mm:ss` */
export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds()
  ).padStart(2, '0')}`
}

/** 各 Cue 的计划触发时刻：场次计划开演起，按前序 Cue 过渡时长累加 */
export function buildPlannedTimes(cues: readonly Cue[], plannedStart: string, baseDateMs: number): Map<string, number | null> {
  const start = plannedStart ? parseClockAt(plannedStart, baseDateMs) : null
  const map = new Map<string, number | null>()
  if (start === null) {
    cues.forEach((cue) => map.set(cue.id, null))
    return map
  }
  let cumulative = 0
  cues.forEach((cue) => {
    map.set(cue.id, start + cumulative * 1000)
    cumulative += cueTotalSeconds(cue)
  })
  return map
}

/** 跨零点修正：偏差超过 12 小时按 ±24 小时折回（演出跨过午夜） */
export function deviationSeconds(plannedTime: number | null, actualTime: number | null): number | null {
  if (plannedTime === null || actualTime === null) return null
  let diffSec = (actualTime - plannedTime) / 1000
  if (diffSec > 12 * 3600) diffSec -= 24 * 3600
  if (diffSec < -12 * 3600) diffSec += 24 * 3600
  return round1(diffSec)
}

/** 候选综合分：提示语相似度为主，顺序一致性与时刻邻近加权 */
function candidateScore(sim: number, cueIndex: number, entryIndex: number, totalCues: number, totalEntries: number): number {
  const orderRatio = totalCues > 1 && totalEntries > 0 ? 1 - Math.min(1, Math.abs(cueIndex / totalCues - entryIndex / totalEntries)) : 0.5
  return round1Score(sim * 0.75 + orderRatio * 0.25)
}

function round1Score(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100)
}

function buildCandidate(entry: ReconEntry, cueIndex: number, entryIndex: number, cueTotal: number, entryTotal: number, cue: Cue): ReconCandidate {
  const sim = labelSimilarity(cue.label, entry.text)
  const explicitNumber = entry.cueNo !== null && normalizeCueNo(entry.cueNo) !== cue.cueNo
  return {
    entryId: entry.id,
    kind: entry.kind,
    cueNo: entry.cueNo,
    text: entry.text || '（无描述）',
    time: entry.time,
    duplicateTime: entry.duplicateTime,
    score: round1Score(explicitNumber ? sim * 0.6 : candidateScore(sim, cueIndex, entryIndex, cueTotal, entryTotal) / 100),
    reason: explicitNumber ? `编号 ${entry.cueNo} 未命中，提示语相近` : sim >= AUTO_SIMILARITY ? '提示语高度相近' : '提示语 / 触发顺序相近'
  }
}

function toExtraLog(entry: ReconEntry): ReconExtraLog {
  return {
    entryId: entry.id,
    kind: entry.kind,
    cueNo: entry.cueNo,
    text: entry.text || '（无描述）',
    time: entry.time,
    timeText: entry.time !== null ? formatClock(entry.time) : '',
    duplicateTime: entry.duplicateTime
  }
}

/** 带带宽限制的顺序对齐：单调、不交叉，带宽外不允许配对 */
function alignByOrder(cues: readonly Cue[], entries: readonly ReconEntry[], plannedTimes: ReadonlyMap<string, number | null>) {
  const n = cues.length
  const m = entries.length
  const width = Math.min(ALIGN_BAND, Math.max(n, m))
  const NEG = -1e9
  // dp[i][j]：前 i 条 Cue 与前 j 条日志的最优收益；稀疏存储，只保留带宽内
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(NEG))
  const back: Int8Array[] = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)) // 1 配对 2 跳过Cue 3 跳过日志
  dp[0][0] = 0

  const inBand = (i: number, j: number): boolean => Math.abs(i - j) <= width

  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      if (i === 0 && j === 0) continue
      let best = NEG
      let choice = 0
      // 跳过一条日志
      if (j > 0 && dp[i][j - 1] > best) {
        best = dp[i][j - 1]
        choice = 3
      }
      // 跳过一条 Cue（保持未配对）
      if (i > 0 && dp[i - 1][j] > best) {
        best = dp[i - 1][j]
        choice = 2
      }
      // 第 i 条 Cue 与第 j 条日志配对
      if (i > 0 && j > 0 && inBand(i - 1, j - 1)) {
        const sim = labelSimilarity(cues[i - 1].label, entries[j - 1].text)
        const planned = plannedTimes.get(cues[i - 1].id) ?? null
        const actual = entries[j - 1].time
        // 时刻邻近小幅加权（无计划时刻时不加权）
        let timeBoost = 0
        if (planned !== null && actual !== null) {
          const devMin = Math.abs((actual - planned) / 60000)
          timeBoost = Math.max(0, 0.1 - devMin / 600)
        }
        const reward = sim * 10 + timeBoost
        const candidate = dp[i - 1][j - 1] === NEG ? NEG : dp[i - 1][j - 1] + reward
        if (candidate > best) {
          best = candidate
          choice = 1
        }
      }
      if (best > NEG) {
        dp[i][j] = best
        back[i][j] = choice
      }
    }
  }

  const aligned: Array<{ cueIndex: number; entryIndex: number; sim: number }> = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const choice = back[i][j]
    if (choice === 1) {
      i -= 1
      j -= 1
      aligned.push({ cueIndex: i, entryIndex: j, sim: labelSimilarity(cues[i].label, entries[j].text) })
    } else if (choice === 2) {
      i -= 1
    } else {
      j -= 1
    }
  }
  aligned.reverse()
  return aligned
}

/** 依据完整报告重算统计（人工确认 / 取消配对后调用） */
export function recomputeStats(report: Pick<ReconReport, 'pairs' | 'unmatchedCueIds' | 'extraLogs' | 'gaps'>): ReconStats {
  let matched = 0
  let candidates = 0
  let lateCount = 0
  let earlyCount = 0
  const deviations: number[] = []

  report.pairs.forEach((pair) => {
    if (pair.status === 'candidate') {
      candidates += 1
      return
    }
    if (pair.entryId !== null) {
      matched += 1
      if (pair.deviationSec !== null) {
        deviations.push(Math.abs(pair.deviationSec))
        if (pair.deviationSec > 0) lateCount += 1
        else if (pair.deviationSec < 0) earlyCount += 1
      }
    }
  })

  const median = deviations.length === 0 ? null : round1([...deviations].sort((a, b) => a - b)[Math.floor(deviations.length / 2)])

  return {
    cueTotal: report.pairs.length + report.unmatchedCueIds.length,
    matched,
    candidates,
    unmatchedCues: report.unmatchedCueIds.length,
    unmatchedLogs: report.extraLogs.length,
    gaps: report.gaps.length,
    medianAbsDeviationSec: median,
    lateCount,
    earlyCount
  }
}

export interface ReconcileInput {
  cues: readonly Cue[]
  entries: readonly ReconEntry[]
  plannedStart: string
  baseDateMs: number
  gapThresholdSec: number
}

export interface ReconcileResult {
  pairs: ReconPair[]
  unmatchedCueIds: string[]
  unmatchedCueNos: string[]
  unmatchedCueLabels: string[]
  extraLogs: ReconExtraLog[]
  gaps: ReconGap[]
  plannedTimes: Record<string, number | null>
  stats: ReconStats
}

/** 执行一次完整对账 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { cues, plannedStart, baseDateMs, gapThresholdSec } = input
  const plannedMap = buildPlannedTimes(cues, plannedStart, baseDateMs)

  // 触发类条目（info 仅在原始日志栏展示），按时刻 / 行号排序
  const triggerEntries = input.entries
    .filter((entry) => entry.kind !== 'info')
    .sort((a, b) => (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq)

  const consumedEntryIds = new Set<string>()
  const pairByCue = new Map<string, ReconPair>()
  const cueNumberSet = new Set(cues.map((cue) => normalizeCueNo(cue.cueNo)))

  // —— 第一遍：Cue 编号直接锚定（同编号多条时取时刻最接近计划的一条） ——
  cues.forEach((cue) => {
    const expectedNo = normalizeCueNo(cue.cueNo)
    const candidatesOfNo = triggerEntries.filter((entry) => !consumedEntryIds.has(entry.id) && entry.cueNo === expectedNo)
    if (candidatesOfNo.length === 0) return
    const planned = plannedMap.get(cue.id) ?? null
    const picked =
      planned === null
        ? candidatesOfNo[0]
        : candidatesOfNo.reduce((best, entry) => {
            if (entry.time === null) return best
            if (best.time === null) return entry
            return Math.abs(entry.time - planned) < Math.abs(best.time - planned) ? entry : best
          }, candidatesOfNo[0])

    consumedEntryIds.add(picked.id)
    pairByCue.set(cue.id, {
      cueId: cue.id,
      cueNo: cue.cueNo,
      label: cue.label,
      status: 'matched',
      entryId: picked.id,
      entryKind: picked.kind,
      entryText: picked.text || '（无描述）',
      actualTime: picked.time,
      plannedTime: planned,
      deviationSec: deviationSeconds(planned, picked.time),
      matchReason: `编号 ${expectedNo} 命中`,
      candidates: []
    })
  })

  // —— 第二遍：剩余 Cue 与剩余条目做触发顺序对齐 ——
  const restCues = cues.filter((cue) => !pairByCue.has(cue.id))
  const restEntries = triggerEntries.filter((entry) => !consumedEntryIds.has(entry.id))
  const aligned = alignByOrder(restCues, restEntries, plannedMap)

  aligned.forEach(({ cueIndex, entryIndex, sim }) => {
    const cue = restCues[cueIndex]
    const entry = restEntries[entryIndex]
    const planned = plannedMap.get(cue.id) ?? null
    if (sim >= AUTO_SIMILARITY) {
      consumedEntryIds.add(entry.id)
      pairByCue.set(cue.id, {
        cueId: cue.id,
        cueNo: cue.cueNo,
        label: cue.label,
        status: 'matched',
        entryId: entry.id,
        entryKind: entry.kind,
        entryText: entry.text || '（无描述）',
        actualTime: entry.time,
        plannedTime: planned,
        deviationSec: deviationSeconds(planned, entry.time),
        matchReason: '提示语 + 触发顺序对上',
        candidates: []
      })
    } else if (sim >= CANDIDATE_SIMILARITY) {
      consumedEntryIds.add(entry.id)
      const candidate = buildCandidate(
        entry,
        cues.indexOf(cue),
        triggerEntries.indexOf(entry),
        cues.length,
        triggerEntries.length,
        cue
      )
      pairByCue.set(cue.id, {
        cueId: cue.id,
        cueNo: cue.cueNo,
        label: cue.label,
        status: 'candidate',
        entryId: entry.id,
        entryKind: entry.kind,
        entryText: entry.text || '（无描述）',
        actualTime: entry.time,
        plannedTime: planned,
        deviationSec: deviationSeconds(planned, entry.time),
        matchReason: '提示语部分相近，待确认',
        candidates: [candidate]
      })
    }
  })

  // —— 第三遍：仍未对上的 Cue 收集候选；候选只保留，不自动配对 ——
  const pool = triggerEntries.filter((entry) => !consumedEntryIds.has(entry.id))
  cues.forEach((cue) => {
    if (pairByCue.has(cue.id)) return
    const cueIndex = cues.indexOf(cue)
    const ranked = pool
      .map((entry) => ({
        entry,
        candidate: buildCandidate(
          entry,
          cueIndex,
          triggerEntries.indexOf(entry),
          cues.length,
          triggerEntries.length,
          cue
        )
      }))
      // 显式编号但没命中计划编号的条目，相似度门槛更高
      .filter(({ candidate, entry }) => candidate.score >= (entry.cueNo !== null && !cueNumberSet.has(normalizeCueNo(entry.cueNo)) ? 45 : 30))
      .sort((a, b) => b.candidate.score - a.candidate.score)
      .slice(0, MAX_CANDIDATES)
      .map(({ candidate }) => candidate)

    pairByCue.set(cue.id, {
      cueId: cue.id,
      cueNo: cue.cueNo,
      label: cue.label,
      status: 'candidate',
      entryId: null,
      entryKind: null,
      entryText: '',
      actualTime: null,
      plannedTime: plannedMap.get(cue.id) ?? null,
      deviationSec: null,
      matchReason: ranked.length > 0 ? '未自动对上，以下为候选' : '无候选',
      candidates: ranked
    })
  })

  // 顺序校验：对上的条目在时间轴上应与 Cue 顺序单调一致，逆序给出标记
  const resolvedPairs = cues
    .map((cue) => pairByCue.get(cue.id))
    .filter((pair): pair is ReconPair => pair !== undefined && pair.entryId !== null)
  resolvedPairs.forEach((pair, index) => {
    if (index === 0) return
    const prev = resolvedPairs[index - 1]
    const prevEntry = triggerEntries.find((entry) => entry.id === prev.entryId)
    const thisEntry = triggerEntries.find((entry) => entry.id === pair.entryId)
    if (prevEntry && thisEntry && (thisEntry.time ?? Infinity) < (prevEntry.time ?? -Infinity)) {
      pair.matchReason += '（触发顺序与计划相反）'
    }
  })

  // 组装分栏结果
  const pairs: ReconPair[] = []
  const unmatchedCueIds: string[] = []
  const unmatchedCueNos: string[] = []
  const unmatchedCueLabels: string[] = []
  cues.forEach((cue) => {
    const pair = pairByCue.get(cue.id)
    if (!pair) {
      unmatchedCueIds.push(cue.id)
      unmatchedCueNos.push(cue.cueNo)
      unmatchedCueLabels.push(cue.label)
      return
    }
    if (pair.status === 'candidate' && pair.entryId === null && pair.candidates.length === 0) {
      unmatchedCueIds.push(cue.id)
      unmatchedCueNos.push(cue.cueNo)
      unmatchedCueLabels.push(cue.label)
      return
    }
    pairs.push(pair)
  })

  const usedEntryIds = new Set<string>()
  pairs.forEach((pair) => {
    if (pair.entryId) usedEntryIds.add(pair.entryId)
    pair.candidates.forEach((candidate) => usedEntryIds.add(candidate.entryId))
  })
  const extraLogs = triggerEntries
    .filter((entry) => !usedEntryIds.has(entry.id))
    .map(toExtraLog)

  // 缺段：相邻有效触发时刻断档超过阈值
  const gaps: ReconGap[] = []
  const timed = triggerEntries.filter((entry) => entry.time !== null)
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1]
    const curr = timed[i]
    const gapSec = round1(((curr.time as number) - (prev.time as number)) / 1000)
    if (gapSec > gapThresholdSec) {
      gaps.push({
        fromTime: prev.time as number,
        toTime: curr.time as number,
        gapSec,
        fromText: prev.text || prev.cueNo || '（无描述）',
        toText: curr.text || curr.cueNo || '（无描述）'
      })
    }
  }

  const stats = recomputeStats({ pairs, unmatchedCueIds, extraLogs, gaps })

  return {
    pairs,
    unmatchedCueIds,
    unmatchedCueNos,
    unmatchedCueLabels,
    extraLogs,
    gaps,
    plannedTimes: Object.fromEntries(cues.map((cue) => [cue.id, plannedMap.get(cue.id) ?? null])),
    stats
  }
}

/** 人工把某条日志配到某条 Cue（可从候选、未对上日志或另一条 Cue 处改配） */
export function applyResolution(
  report: ReconReport,
  cueId: string,
  entry: { id: string; kind: ConsoleLogEntry['kind']; cueNo: string | null; text: string; time: number | null; duplicateTime: boolean },
  liveCue?: { cueNo: string; label: string }
): void {
  const planned = report.plannedTimes[cueId] ?? null

  // 从其他配对行上摘下这条日志：那一行的 Cue 回到未对上栏
  const occupant = report.pairs.find((pair) => pair.entryId === entry.id && pair.cueId !== cueId)
  if (occupant) {
    report.unmatchedCueIds.push(occupant.cueId)
    report.unmatchedCueNos.push(occupant.cueNo)
    report.unmatchedCueLabels.push(occupant.label)
    report.pairs = report.pairs.filter((pair) => pair.cueId !== occupant.cueId)
  }
  // 从所有候选列表中移除
  report.pairs.forEach((pair) => {
    pair.candidates = pair.candidates.filter((candidate) => candidate.entryId !== entry.id)
  })
  // 从「未对上日志」移除
  report.extraLogs = report.extraLogs.filter((extra) => extra.entryId !== entry.id)

  // 目标 Cue 当前在未对上栏：记下快照后移出
  const unmatchedIndex = report.unmatchedCueIds.indexOf(cueId)
  let cueNo = liveCue?.cueNo ?? cueId
  let label = liveCue?.label ?? ''
  if (unmatchedIndex >= 0) {
    cueNo = report.unmatchedCueNos[unmatchedIndex]
    label = report.unmatchedCueLabels[unmatchedIndex]
    report.unmatchedCueIds.splice(unmatchedIndex, 1)
    report.unmatchedCueNos.splice(unmatchedIndex, 1)
    report.unmatchedCueLabels.splice(unmatchedIndex, 1)
  }

  const existing = report.pairs.find((pair) => pair.cueId === cueId)
  const nextPair: ReconPair = {
    cueId,
    cueNo: existing?.cueNo ?? cueNo,
    label: existing?.label ?? label,
    status: 'matched',
    entryId: entry.id,
    entryKind: entry.kind,
    entryText: entry.text || '（无描述）',
    actualTime: entry.time,
    plannedTime: planned,
    deviationSec: deviationSeconds(planned, entry.time),
    matchReason: '人工指定配对',
    candidates: []
  }
  if (existing) {
    report.pairs.splice(report.pairs.indexOf(existing), 1, nextPair)
  } else {
    report.pairs.push(nextPair)
  }
  report.stats = recomputeStats(report)
}

/** 取消某行配对：日志回到「未对上日志」栏，Cue 回到未对上栏 */
export function unpair(report: ReconReport, cueId: string): void {
  const index = report.pairs.findIndex((pair) => pair.cueId === cueId)
  if (index < 0) return
  const pair = report.pairs[index]
  report.pairs.splice(index, 1)
  report.unmatchedCueIds.push(cueId)
  report.unmatchedCueNos.push(pair.cueNo)
  report.unmatchedCueLabels.push(pair.label)

  // 主配对条目回到「未对上日志」
  if (pair.entryId && !report.extraLogs.some((extra) => extra.entryId === pair.entryId)) {
    report.extraLogs.push({
      entryId: pair.entryId,
      kind: pair.entryKind ?? 'manual',
      cueNo: null,
      text: pair.entryText || '（无描述）',
      time: pair.actualTime,
      timeText: pair.actualTime !== null ? formatClock(pair.actualTime) : '',
      duplicateTime: false
    })
  }
  // 候选引用的其他日志也放回
  pair.candidates.forEach((candidate) => {
    if (candidate.entryId === pair.entryId) return
    if (report.extraLogs.some((extra) => extra.entryId === candidate.entryId)) return
    report.extraLogs.push({
      entryId: candidate.entryId,
      kind: candidate.kind,
      cueNo: candidate.cueNo,
      text: candidate.text,
      time: candidate.time,
      timeText: candidate.time !== null ? formatClock(candidate.time) : '',
      duplicateTime: candidate.duplicateTime
    })
  })

  // extraLogs 保持时间序
  report.extraLogs.sort((a, b) => (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER))
  report.stats = recomputeStats(report)
}
