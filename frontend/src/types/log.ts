/** 灯控台日志触发动作分类 */
export const LOG_TRIGGER_KINDS = ['go', 'manual', 'auto', 'unknown'] as const
export type LogTriggerKind = (typeof LOG_TRIGGER_KINDS)[number]

/** 日志条目：触发记录参与对账，系统信息行只计数不入库 */
export type LogEntryKind = 'trigger' | 'info'

/**
 * 灯控台日志中的一条触发记录。
 * id 采用 `logId:L行号` 的确定性主键：断点续传重读已处理行时是幂等覆盖，不会产生重复条目。
 */
export interface ConsoleLogEntry {
  /** 确定性主键：`${logId}:L${lineNo}` */
  id: string
  logId: string
  sessionId: string
  /** 源文件行号（含未入库的 info / 空行），同时是触发顺序的稳定排序键 */
  lineNo: number
  /** 当天内毫秒数；无法解析时间戳时为 null */
  timeOfDayMs: number | null
  /** 原始时间戳文本 */
  rawTimestamp: string
  /** 归一化 Cue 编号（Q12.5）；日志行无编号时为空串（如手动补点） */
  cueNo: string
  kind: LogEntryKind
  triggerKind: LogTriggerKind
  /** 去掉时间戳 / 级别 / 编号 / 动作词之后的消息文本 */
  message: string
  /** 原始行（截断保存） */
  raw: string
  /** 与上一条触发记录时间戳完全相同 */
  dupTimestamp: boolean
}

/** 导入状态：importing 可随时从断点继续，failed 保留进度等待重试 */
export type LogImportStatus = 'importing' | 'done' | 'failed'

/** 一次灯控台日志导入（含断点续传所需的全部进度） */
export interface ConsoleLog {
  /** 主键 */
  id: string
  /** 所属场次 */
  sessionId: string
  fileName: string
  /** 源文件大小（字节），用于进度与续传校验 */
  fileSize: number
  /** 首次导入时间 ISO */
  importedAt: string
  status: LogImportStatus
  /** 已消费字节偏移：中断后从此处继续读取 */
  bytesOffset: number
  bytesTotal: number
  /** 已处理的源文件行数 */
  totalLines: number
  /** 已入库触发条目数 */
  entryCount: number
  /** 识别为系统信息 / 电平记录而跳过的行数 */
  infoCount: number
  /** 无法识别的行数（无时间戳且无 Cue 编号 / 动作词） */
  malformedCount: number
  /** 无法识别行的原文样例（最多保留 5 条） */
  malformedSamples: string[]
  /** 导入阶段产生的提示（重复时间戳等） */
  warnings: string[]
  finishedAt: string | null
  /** 最近一次失败原因 */
  error: string | null
}

/** 日志导入 / 读取的实时进度 */
export interface LogProgress {
  logId: string
  /** 已完成量（字节或条目数，依 phase 而定） */
  done: number
  total: number
  /** 0-1，供进度条使用 */
  ratio: number
  phase: 'read' | 'query' | 'reconcile'
}
