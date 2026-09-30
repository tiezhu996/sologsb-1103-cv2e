import type { CueTrigger } from '@/types/cue'
import type { LogTriggerKind } from '@/types/log'

/** 配对依据：编号命中 / 提示语命中 / 仅触发顺序就近 */
export const MATCH_REASONS = ['cueNo', 'label', 'sequence'] as const
export type MatchReason = (typeof MATCH_REASONS)[number]

/** 单条配对候选（Cue ↔ 日志条目） */
export interface MatchCandidate {
  cueId: string
  entryId: string
  cueNo: string
  /** 0-100 的综合把握度 */
  score: number
  /** 编号相同（强信号） */
  cueNoHit: boolean
  /** 提示语相似度 0-1 */
  labelSimilarity: number
  /** 触发位次差（绝对值） */
  orderDistance: number
  /** 时间偏差（秒）；缺少时间戳时为 null */
  deviationSec: number | null
  reasons: MatchReason[]
  /* —— 以下为日志侧冗余展示字段，避免页面再次分批加载 —— */
  /** 日志中写出的编号（手动补点时可能为空） */
  logCueNo: string
  logSeq: number
  actualTime: string | null
  logMessage: string
  logKind: LogTriggerKind
}

/** 已确认的对账条目 */
export interface MatchedPair {
  cueId: string
  entryId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  /** 触发顺序位次（按场次 Cue 顺序，从 1 起） */
  cueOrder: number
  /** 日志触发序号（从 1 起） */
  logSeq: number
  /** 计划时刻（HH:mm，取自场次 plan + Cue 位次推估；无计划信息时为 null） */
  plannedTime: string | null
  /** 日志实际触发时刻（HH:mm:ss）；日志缺时间戳时为 null */
  actualTime: string | null
  /** 实际 - 计划（秒）；无法计算时为 null */
  deviationSec: number | null
  score: number
  reasons: MatchReason[]
  logKind: LogTriggerKind
  logMessage: string
}

/** 对账状态：confirmed 为系统自动确认，candidate 为待人工裁决 */
export type ReconcileItemStatus = 'confirmed' | 'candidate'

/** 没对上的 Cue */
export interface UnmatchedCue {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  cueOrder: number
  plannedTime: string | null
  /** 候选的日志条目 id（按把握度排序） */
  candidateEntryIds: string[]
}

/** 没对上的日志条目 */
export interface UnmatchedLog {
  entryId: string
  logSeq: number
  cueNo: string
  actualTime: string | null
  triggerKind: LogTriggerKind
  message: string
  lineNo: number
  /** 候选的 Cue id（按把握度排序） */
  candidateCueIds: string[]
}

/** 一次对账的完整结果（可重算、可落库） */
export interface ReconcileReport {
  id: string
  sessionId: string
  logId: string
  createdAt: string
  /** 参与对账的 Cue 数 */
  cueCount: number
  /** 参与对账的日志条目数 */
  logCount: number
  pairs: MatchedPair[]
  unmatchedCues: UnmatchedCue[]
  unmatchedLogs: UnmatchedLog[]
  /** 全部候选（含已确认与未确认），供人工筛选 */
  candidates: MatchCandidate[]
}
