/**
 * 灯控台日志对账（Console Log Reconciliation）相关模型。
 *
 * 数据流：
 *   原始日志文件 → 分批解析为 ConsoleLogEntry 落库（支持断点续传）
 *               → 与场次内排好的 Cue 按「编号 → 提示语 → 触发顺序」配对
 *               → 产出 ReconReport（对上 / 候选 / 未对上 Cue / 未对上日志 / 缺段）
 */

/** 日志条目识别出的类别 */
export const LOG_ENTRY_KINDS = ['cue', 'manual', 'info'] as const
export type LogEntryKind = (typeof LOG_ENTRY_KINDS)[number]

/** 导入任务状态 */
export const IMPORT_STATUS = ['parsing', 'paused', 'failed', 'done'] as const
export type ImportStatus = (typeof IMPORT_STATUS)[number]

/** 一条解析后的控台日志记录 */
export interface ConsoleLogEntry {
  /** 主键 */
  id: string
  /** 所属导入任务 */
  importId: string
  /** 所属场次（冗余，便于按场次索引查询） */
  sessionId: string
  /** 在原始文件中的行号（1 基，跳过空行） */
  seq: number
  /** 触发时刻（毫秒）；行内没有可识别时间戳时取 null */
  time: number | null
  /** 归一化后的时间文本，例如 `19:32:05`，便于界面展示与去重标记 */
  timeText: string
  /** 条目类别：cue 带编号的触发 / manual 手动补点 / info 其他日志 */
  kind: LogEntryKind
  /** 归一化 Cue 编号（`Q12` / `Q12.5`），无编号为 null */
  cueNo: string | null
  /** 去掉时间戳与编号后的描述文本（提示语 / 补点说明 / 原始日志正文） */
  text: string
  /** 原始行，留档排查用 */
  raw: string
  /** 时间戳与上一条有效时间是否完全相同（重复时间戳标记） */
  duplicateTime: boolean
}

/**
 * 日志导入任务：保存分批解析进度，中途失败 / 关页面后可从断点续传。
 * 进度以「已消费字符数」记录，续传时从 offset 继续扫描。
 */
export interface LogImport {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  /** 原始文件名 */
  fileName: string
  /** 文件大小（字节） */
  fileSize: number
  /** 日志采用的日期（`YYYY-MM-DD`），HH:mm:ss 时间戳拼日期用，默认导入当天 */
  logDate: string
  /** 任务状态 */
  status: ImportStatus
  /** 已处理到的文件字符偏移（断点） */
  offset: number
  /** 已写入条目数 */
  lineCount: number
  /** 已识别触发条目数（kind = cue / manual） */
  triggerCount: number
  /** 最近一次失败原因（status = failed 时有值） */
  lastError: string
  createdAt: number
  updatedAt: number
}

/** 配对状态：matched 自动对上 / candidate 仅候选待人工确认 */
export const PAIR_STATUS = ['matched', 'candidate'] as const
export type PairStatus = (typeof PAIR_STATUS)[number]

/** 候选：一条未对上的日志可能对应某条 Cue，由提示语相似度 / 触发顺序算出 */
export interface ReconCandidate {
  /** 候选日志条目 id */
  entryId: string
  /** 日志条目类别 */
  kind: LogEntryKind
  /** 归一化 Cue 编号（日志里带编号但没配上时展示） */
  cueNo: string | null
  /** 描述文本 */
  text: string
  /** 触发时刻（毫秒） */
  time: number | null
  /** 是否为重复时间戳条目 */
  duplicateTime: boolean
  /** 匹配置信分 0-100（提示语相似度 + 触发顺序一致性） */
  score: number
  /** 命中依据：cueNo 编号 / label 提示语 / order 触发顺序 */
  reason: string
}

/** 一条 Cue 与一条日志的对账结果行 */
export interface ReconPair {
  /** 配对主键，与 cueId 一一对应（已配对 / 候选中的 Cue） */
  cueId: string
  /** Cue 编号快照 */
  cueNo: string
  /** 提示语快照 */
  label: string
  /** 配对状态 */
  status: PairStatus
  /** 对上的日志条目 id；candidate 预选了某条时有值 */
  entryId: string | null
  /** 对上的日志条目类别（取消配对时用于还原到未对上日志栏） */
  entryKind: LogEntryKind | null
  /** 对上的日志描述文本快照 */
  entryText: string
  /** 实际触发时刻（毫秒），取日志条目时间 */
  actualTime: number | null
  /** 计划时刻（毫秒），由场次计划开演 + Cue 过渡时长推算 */
  plannedTime: number | null
  /** 偏差秒（actual - planned），晚为正、早为负；缺任一时刻为 null */
  deviationSec: number | null
  /** 配对依据（编号 / 提示语 / 触发顺序 / 人工指定） */
  matchReason: string
  /** 候选列表（status = candidate 时有值） */
  candidates: ReconCandidate[]
}

/** 未对上的日志条目（手动补点、计划外触发等） */
export interface ReconExtraLog {
  entryId: string
  kind: LogEntryKind
  cueNo: string | null
  text: string
  time: number | null
  timeText: string
  /** 是否为重复时间戳条目 */
  duplicateTime: boolean
}

/** 日志缺段：相邻有效触发时刻之间的断档 */
export interface ReconGap {
  /** 缺段开始时刻（毫秒），取自前一条日志 */
  fromTime: number
  /** 缺段结束时刻（毫秒），取自后一条日志 */
  toTime: number
  /** 断档秒数 */
  gapSec: number
  /** 缺段前一条日志描述 */
  fromText: string
  /** 缺段后一条日志描述 */
  toText: string
}

/** 对账报告统计 */
export interface ReconStats {
  /** 场次内 Cue 总数 */
  cueTotal: number
  /** 自动对上数 */
  matched: number
  /** 候选待确认数 */
  candidates: number
  /** 未对上 Cue 数 */
  unmatchedCues: number
  /** 未对上日志数 */
  unmatchedLogs: number
  /** 日志缺段数 */
  gaps: number
  /** 已对上条目偏差绝对值的中位数（秒），无数据为 null */
  medianAbsDeviationSec: number | null
  /** 晚触发条数（deviationSec > 0） */
  lateCount: number
  /** 早触发条数（deviationSec < 0） */
  earlyCount: number
}

/**
 * 对账报告：一次导入与当时 Cue 表的配对结果。
 * 历史排演表的生成时快照照旧保留；本报告同样保存生成时刻的配对结果，
 * 之后修改 Cue 不影响已存在的报告。
 */
export interface ReconReport {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  /** 来源导入任务 id */
  importId: string
  /** 报告编号，形如 `RC-20250930-01` */
  reportNo: string
  /** 生成时间 ISO 字符串 */
  generatedAt: string
  /** 制表备注 */
  note: string
  /** 生成时场次标题快照 */
  sessionTitle: string
  /** 日志缺段判定阈值（秒） */
  gapThresholdSec: number
  /** 对账行：对上与候选（按 Cue 时间轴顺序） */
  pairs: ReconPair[]
  /** 未对上 Cue 的 id 列表（按时间轴顺序） */
  unmatchedCueIds: string[]
  /** 未对上 Cue 的编号快照，防止之后 Cue 被删 */
  unmatchedCueNos: string[]
  /** 未对上 Cue 的提示语快照 */
  unmatchedCueLabels: string[]
  /** 各 Cue 计划触发时刻快照（cueId → 毫秒），人工改配时取计划时刻用 */
  plannedTimes: Record<string, number | null>
  /** 未对上日志 */
  extraLogs: ReconExtraLog[]
  /** 日志缺段 */
  gaps: ReconGap[]
  /** 汇总统计 */
  stats: ReconStats
}
