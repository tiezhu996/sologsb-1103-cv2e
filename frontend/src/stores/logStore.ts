import Dexie from 'dexie'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ConsoleLog, ConsoleLogEntry, LogProgress } from '@/types/log'
import type {
  MatchedPair,
  ReconcileReport,
  UnmatchedCue,
  UnmatchedLog
} from '@/types/reconcile'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { parseLogLines } from '@/utils/logParse'
import {
  buildPlannedMap,
  deviationSeconds,
  labelSimilarity,
  msToClock,
  reconcile as runReconcile
} from '@/utils/reconcile'
import { useCueStore } from '@/stores/cueStore'
import { useSessionStore } from '@/stores/sessionStore'

/** 每批读取字节数（256 KB），控制单帧工作量 */
const READ_CHUNK_BYTES = 256 * 1024
/** 每批解析的行数 */
const PARSE_BATCH_LINES = 2000
/** 每批入库条目数 */
const PUT_BATCH = 500
/** 对账枚举 / 渲染时每批让出主线程的边数 */
const YIELD_EDGES = 4000
/** 异常行样例上限 */
const MALFORMED_SAMPLE_LIMIT = 5

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 同一会话内保留的 File 句柄，导入失败后无需重新选文件即可续传 */
const fileHandles = new Map<string, File>()

function entryId(logId: string, lineNo: number): string {
  return `${logId}:L${lineNo}`
}

export interface StartImportResult {
  log: ConsoleLog
  resumed: boolean
}

/**
 * 灯控台日志仓库：分批导入（可断点续传）、分批加载条目、分批对账与候选人工裁决。
 */
export const useLogStore = defineStore('log', () => {
  const logs = ref<ConsoleLog[]>([])
  const reports = ref<ReconcileReport[]>([])
  const hydrated = ref(false)
  /** 当前正在运行的导入进度（logId → 进度） */
  const running = ref<Record<string, LogProgress>>({})

  const logsSorted = computed(() =>
    [...logs.value].sort((a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime())
  )

  const reportsSorted = computed(() =>
    [...reports.value].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  )

  function logById(id: string): ConsoleLog | null {
    return logs.value.find((log) => log.id === id) ?? null
  }

  function reportById(id: string): ReconcileReport | null {
    return reports.value.find((report) => report.id === id) ?? null
  }

  function reportsOfLog(logId: string): ReconcileReport[] {
    return reportsSorted.value.filter((report) => report.logId === logId)
  }

  function latestReportOfLog(logId: string): ReconcileReport | null {
    return reportsOfLog(logId)[0] ?? null
  }

  function logsOfSession(sessionId: string): ConsoleLog[] {
    return logsSorted.value.filter((log) => log.sessionId === sessionId)
  }

  async function hydrate(): Promise<void> {
    const [storedLogs, storedReports] = await Promise.all([
      db.consoleLogs.toArray(),
      db.reconcileReports.toArray()
    ])
    logs.value = storedLogs
    reports.value = storedReports
    hydrated.value = true
  }

  function patchLog(id: string, patch: Partial<ConsoleLog>): void {
    logs.value = logs.value.map((log) => (log.id === id ? { ...log, ...patch } : log))
  }

  function setProgress(progress: LogProgress | null): void {
    if (!progress) {
      running.value = {}
      return
    }
    running.value = { ...running.value, [progress.logId]: progress }
  }

  /**
   * 新建或继续一次导入。
   * - 全新文件：建 importing 记录，从偏移 0 开始
   * - 已有同名同大小未完成记录：直接从断点继续
   */
  async function startImport(
    sessionId: string,
    file: File,
    onProgress?: (progress: LogProgress) => void
  ): Promise<StartImportResult> {
    const existing = logs.value.find(
      (log) =>
        log.sessionId === sessionId &&
        log.fileName === file.name &&
        log.fileSize === file.size &&
        log.status !== 'done'
    )
    if (existing) {
      await resumeImport(existing.id, file, onProgress)
      return { log: logById(existing.id)!, resumed: true }
    }

    const now = new Date().toISOString()
    const log: ConsoleLog = {
      id: createId('log'),
      sessionId,
      fileName: file.name,
      fileSize: file.size,
      importedAt: now,
      status: 'importing',
      bytesOffset: 0,
      bytesTotal: file.size,
      totalLines: 0,
      entryCount: 0,
      infoCount: 0,
      malformedCount: 0,
      malformedSamples: [],
      warnings: [],
      finishedAt: null,
      error: null
    }
    await db.consoleLogs.put(log)
    logs.value = [...logs.value, log]
    fileHandles.set(log.id, file)
    await runImport(log.id, file, onProgress)
    return { log: logById(log.id)!, resumed: false }
  }

  /** 从断点继续：优先用内存句柄，其次用重新选择的同名文件 */
  async function resumeImport(
    logId: string,
    file?: File,
    onProgress?: (progress: LogProgress) => void
  ): Promise<void> {
    const stored = logById(logId)
    if (!stored) throw new Error('导入记录不存在')
    const handle = file ?? fileHandles.get(logId)
    if (!handle) {
      throw new Error('请重新选择原始日志文件以从断点继续')
    }
    if (file) fileHandles.set(logId, file)
    if (stored.status === 'done') return

    // 文件被截断（换了内容更小的同名文件）→ 丢弃旧进度重来
    if (handle.size < stored.bytesOffset) {
      await db.logEntries.where('logId').equals(logId).delete()
      const reset: ConsoleLog = {
        ...stored,
        status: 'importing',
        bytesOffset: 0,
        totalLines: 0,
        entryCount: 0,
        infoCount: 0,
        malformedCount: 0,
        malformedSamples: [],
        warnings: [],
        error: null
      }
      await db.consoleLogs.put(reset)
      patchLog(logId, reset)
    } else {
      patchLog(logId, { status: 'importing', error: null })
      await db.consoleLogs.update(logId, { status: 'importing', error: null })
    }
    await runImport(logId, handle, onProgress)
  }

  /**
   * 分批读取 + 解析 + 入库主循环。
   * - 条目主键绑定源行号（logId:L行号），断点续传重读旧行时幂等覆盖，不产生重复
   * - 字节偏移落在 chunk 边界；任何一批失败停在断点（status=failed），已入库行计数不回退
   */
  async function runImport(logId: string, file: File, onProgress?: (progress: LogProgress) => void): Promise<void> {
    const stored = logById(logId)
    if (!stored) return
    const sessionId = stored.sessionId
    let offset = stored.bytesOffset
    let maxLineNo = stored.totalLines
    let infoCount = stored.infoCount
    let malformedCount = stored.malformedCount
    const malformedSamples = [...stored.malformedSamples]

    // 从已入库条目重建：触发行号集合（精确计数）与时间戳→首行映射（重复检测）
    const seenTimestamps = new Map<number, number>()
    const dupLineSet = new Set<number>()
    const triggerLineNos = new Set<number>()
    await db.logEntries
      .where('[logId+lineNo]')
      .between([logId, Dexie.minKey], [logId, Dexie.maxKey])
      .each((entry: ConsoleLogEntry) => {
        triggerLineNos.add(entry.lineNo)
        if (entry.timeOfDayMs !== null) seenTimestamps.set(entry.timeOfDayMs, entry.lineNo)
        if (entry.dupTimestamp) dupLineSet.add(entry.lineNo)
      })

    const emit = (phase: LogProgress['phase'], done: number, total: number): void => {
      const ratio = total <= 0 ? 0 : Math.min(1, done / total)
      const progress: LogProgress = { logId, done, total, ratio, phase }
      setProgress(progress)
      onProgress?.(progress)
    }

    /** 本次运行新见到的 info / malformed 行号（行号 > 历史水位才算新增，重扫旧行不重复计数） */
    const seenInfoLines = new Set<number>()
    const seenMalformedLines = new Set<number>()
    const historicalLineWatermark = stored.totalLines
    const historicalInfoCount = stored.infoCount
    const historicalMalformedCount = stored.malformedCount

    /** 解析并落库一批行（主键按行号幂等），各类计数均按行号去重；返回本批末行行号 */
    async function persistBatch(lines: string[], lineStart: number): Promise<number> {
      const summary = parseLogLines(lines, { startLineNo: lineStart, seenTimestamps })

      const records: ConsoleLogEntry[] = summary.entries.map((entry) => ({
        ...entry,
        id: entryId(logId, entry.lineNo),
        logId,
        sessionId
      }))
      for (let i = 0; i < records.length; i += PUT_BATCH) {
        await db.logEntries.bulkPut(records.slice(i, i + PUT_BATCH))
        await yieldToUI()
      }
      records.forEach((entry) => triggerLineNos.add(entry.lineNo))

      // 跨批次 / 跨会话暴露出来的重复时间戳，双方都补标
      if (summary.duplicateLineNos.size > 0) {
        const backfill = await db.logEntries
          .where('id')
          .anyOf([...summary.duplicateLineNos].map((lineNo) => entryId(logId, lineNo)))
          .toArray()
        await db.logEntries.bulkPut(backfill.map((entry) => ({ ...entry, dupTimestamp: true })))
        backfill.forEach((entry) => dupLineSet.add(entry.lineNo))
      }

      // 续传断点落在换行边界，本次解析到的行号都严格大于历史最高行号；
      // 故本次集合内的行号即为「新增」，与 stored 的历史计数相加即最终值。
      summary.infoLineNos.forEach((lineNo) => {
        if (lineNo > historicalLineWatermark) seenInfoLines.add(lineNo)
      })
      summary.malformedLineNos.forEach((lineNo) => {
        if (lineNo > historicalLineWatermark) seenMalformedLines.add(lineNo)
      })
      infoCount = historicalInfoCount + seenInfoLines.size
      malformedCount = historicalMalformedCount + seenMalformedLines.size

      summary.malformedSamples.forEach((sample) => {
        if (malformedSamples.length < MALFORMED_SAMPLE_LIMIT && !malformedSamples.includes(sample)) {
          malformedSamples.push(sample)
        }
      })
      return summary.endLineNo
    }

    /** 合并两段字节 */
    function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
      if (a.length === 0) return b
      const merged = new Uint8Array(a.length + b.length)
      merged.set(a, 0)
      merged.set(b, a.length)
      return merged
    }

    /** 字节数组中最后一个 \n 的位置（含其后首字节边界），无换行返回 -1 */
    function lastNewline(bytes: Uint8Array): number {
      for (let i = bytes.length - 1; i >= 0; i -= 1) {
        if (bytes[i] === 0x0a) return i + 1
      }
      return -1
    }

    try {
      // 两个绝对文件位置：
      //   readPos    —— 已从文件读取到的字节位置（读取窗口尾）
      //   consumePos —— 已完整解析（遇到换行符）的字节位置，即持久化断点；续传从此处读
      // pending = [consumePos, readPos) 之间尚未遇到换行符的原始字节，且总是「某行前缀」，
      // 所以断点 consumePos 永远落在行首，跨会话续传无需任何内存状态也不会切到多字节字符中间。
      let readPos = offset
      let consumePos = offset
      let pending = new Uint8Array(0)

      while (readPos < file.size) {
        const sliceEnd = Math.min(file.size, readPos + READ_CHUNK_BYTES)
        const isLastChunk = sliceEnd >= file.size
        const buffer = await file.slice(readPos, sliceEnd).arrayBuffer()
        const buffered = concatBytes(pending, new Uint8Array(buffer))

        let completeBytes: Uint8Array
        if (isLastChunk) {
          completeBytes = buffered
          pending = new Uint8Array(0)
        } else {
          const boundary = lastNewline(buffered)
          if (boundary < 0) {
            // 累积区 + 整块仍无换行（超长行）：整块保留，只推进读取窗口，断点不动
            pending = buffered
            readPos = sliceEnd
            emit('read', consumePos, file.size)
            await yieldToUI()
            continue
          }
          completeBytes = buffered.subarray(0, boundary)
          pending = buffered.subarray(boundary)
        }

        const decoder = new TextDecoder('utf-8')
        const text = decoder.decode(completeBytes, { stream: false })
        const lines = text.split(/\r\n|\r|\n/)
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

        const firstLineNo = maxLineNo + 1
        for (let start = 0; start < lines.length; start += PARSE_BATCH_LINES) {
          const endLineNo = await persistBatch(lines.slice(start, start + PARSE_BATCH_LINES), firstLineNo + start)
          maxLineNo = Math.max(maxLineNo, endLineNo)
          await yieldToUI()
        }

        readPos = sliceEnd
        // 已消费字节数 = 本次 buffered 总长 - 剩余 pending 长；加到旧 consumePos
        consumePos += completeBytes.length

        const patch: Partial<ConsoleLog> = {
          bytesOffset: isLastChunk ? file.size : consumePos,
          totalLines: maxLineNo,
          entryCount: triggerLineNos.size,
          infoCount,
          malformedCount,
          malformedSamples
        }
        await db.consoleLogs.update(logId, patch)
        patchLog(logId, patch)
        emit('read', Math.min(consumePos, file.size), file.size)
        await yieldToUI()
      }

      const warnings: string[] = []
      if (dupLineSet.size > 0) warnings.push(`发现 ${dupLineSet.size} 条触发记录与其他行时间戳完全相同，已标记`)
      if (malformedCount > 0) warnings.push(`${malformedCount} 行无法识别（无时间戳 / 编号 / 动作词），未计入对账`)

      const finished: ConsoleLog = {
        ...stored,
        status: 'done',
        bytesOffset: file.size,
        bytesTotal: file.size,
        totalLines: maxLineNo,
        entryCount: triggerLineNos.size,
        infoCount,
        malformedCount,
        malformedSamples,
        warnings,
        finishedAt: new Date().toISOString(),
        error: null
      }
      await db.consoleLogs.put(finished)
      patchLog(logId, finished)
      setProgress(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed: Partial<ConsoleLog> = { status: 'failed', error: message }
      await db.consoleLogs.update(logId, failed)
      patchLog(logId, failed)
      setProgress(null)
      throw error
    }
  }


  /**
   * 按 [logId+lineNo] 复合索引游标读取（天然按源行号 / 触发先后排序）。
   * Dexie each/until 基于 IndexedDB 异步游标，读取间隙本身就让出主线程，不会卡住页面。
   */
  async function scanEntries(
    logId: string,
    offset: number,
    limit?: number,
    onProgress?: (scanned: number) => void
  ): Promise<{ items: ConsoleLogEntry[]; total: number }> {
    const total = await db.logEntries.where('logId').equals(logId).count()
    const items: ConsoleLogEntry[] = []
    let scanned = 0
    const collection = db.logEntries
      .where('[logId+lineNo]')
      .between([logId, Dexie.minKey], [logId, Dexie.maxKey])
    const visitor = (entry: ConsoleLogEntry): boolean => {
      if (scanned >= offset && (limit === undefined || items.length < limit)) {
        items.push(entry)
      }
      scanned += 1
      onProgress?.(scanned)
      // 返回 true 通知 until 停止遍历
      return limit !== undefined && items.length >= limit
    }
    if (limit !== undefined) {
      await collection.until(visitor, true)
    } else {
      await collection.each((entry: ConsoleLogEntry) => {
        visitor(entry)
      })
    }
    return { items, total }
  }

  /** 分批读取某日志的全部条目（对账用），每批让出主线程 */
  async function loadAllEntries(logId: string, onProgress?: (progress: LogProgress) => void): Promise<ConsoleLogEntry[]> {
    const { items, total } = await scanEntries(logId, 0, undefined, (scanned) => {
      onProgress?.({
        logId,
        done: scanned,
        total,
        ratio: total === 0 ? 1 : Math.min(1, scanned / total),
        phase: 'query'
      })
    })
    return items
  }

  /** 分页读取条目（长日志渲染用） */
  async function entriesPage(logId: string, offset: number, limit: number): Promise<ConsoleLogEntry[]> {
    const { items } = await scanEntries(logId, offset, limit)
    return items
  }

  async function entryById(id: string): Promise<ConsoleLogEntry | null> {
    return (await db.logEntries.get(id)) ?? null
  }

  /** 分批执行对账，生成并落库报告 */
  async function createReconcileReport(
    logId: string,
    onProgress?: (progress: LogProgress) => void
  ): Promise<ReconcileReport> {
    const log = logById(logId)
    if (!log) throw new Error('日志不存在')
    const cueStore = useCueStore()
    const sessionStore = useSessionStore()
    const cues = cueStore.sortedCuesOfSession(log.sessionId)
    const entries = await loadAllEntries(logId, onProgress)

    const report = await runReconcile(cues, entries, {
      sessionId: log.sessionId,
      logId,
      plannedStart: sessionStore.sessionById(log.sessionId)?.plannedStart ?? null,
      shouldYield: (edgeCount) => {
        if (edgeCount % YIELD_EDGES !== 0) return
        onProgress?.({
          logId,
          done: edgeCount,
          total: Math.max(cues.length * entries.length, 1),
          ratio: Math.min(1, edgeCount / Math.max(cues.length * entries.length, 1)),
          phase: 'reconcile'
        })
        return yieldToUI()
      }
    })

    await db.reconcileReports.put(report)
    reports.value = [...reports.value, report]
    onProgress?.({ logId, done: 1, total: 1, ratio: 1, phase: 'reconcile' })
    return report
  }

  function replaceReport(report: ReconcileReport): void {
    reports.value = reports.value.map((item) => (item.id === report.id ? report : item))
  }

  /** 人工确认一个候选配对，从未配对两栏移除 */
  async function confirmCandidate(reportId: string, cueId: string, entryId: string): Promise<ReconcileReport | null> {
    const report = reportById(reportId)
    if (!report) return null
    const cueStore = useCueStore()
    const sessionStore = useSessionStore()
    const cue = cueStore.cueById(cueId)
    const entry = await entryById(entryId)
    if (!cue || !entry) return null

    const orderedCues = cueStore.sortedCuesOfSession(report.sessionId)
    const cueOrder = orderedCues.findIndex((item) => item.id === cueId) + 1
    const plannedMap = buildPlannedMap(orderedCues, sessionStore.sessionById(report.sessionId)?.plannedStart ?? null)
    const plannedMs = plannedMap.get(cueId) ?? null
    const deviationSec = deviationSeconds(entry.timeOfDayMs, plannedMs)
    const candidate = report.candidates.find((item) => item.cueId === cueId && item.entryId === entryId)
    const labelSim = candidate?.labelSimilarity ?? labelSimilarity(cue.label, entry.message)

    // 触发秩：同日志中行号不大于该条的触发条目数（该条自身计入）
    const logSeq = await db.logEntries
      .where('[logId+lineNo]')
      .between([report.logId, Dexie.minKey], [report.logId, entry.lineNo])
      .count()
    const pair: MatchedPair = {
      cueId,
      entryId,
      cueNo: cue.cueNo,
      label: cue.label,
      trigger: cue.trigger,
      cueOrder,
      logSeq,
      plannedTime: plannedMs === null ? null : msToClock(plannedMs, false),
      actualTime: entry.timeOfDayMs === null ? null : msToClock(entry.timeOfDayMs),
      deviationSec,
      score: candidate?.score ?? Math.round(labelSim * 100),
      reasons: candidate?.reasons ?? (labelSim >= 0.4 ? ['label'] : []),
      logKind: entry.triggerKind,
      logMessage: entry.message
    }

    const next: ReconcileReport = {
      ...report,
      pairs: [...report.pairs.filter((item) => item.cueId !== cueId && item.entryId !== entryId), pair].sort(
        (a, b) => a.cueOrder - b.cueOrder
      ),
      unmatchedCues: report.unmatchedCues
        .filter((item) => item.cueId !== cueId)
        .map((item) => ({ ...item, candidateEntryIds: item.candidateEntryIds.filter((id) => id !== entryId) })),
      unmatchedLogs: report.unmatchedLogs
        .filter((item) => item.entryId !== entryId)
        .map((item) => ({ ...item, candidateCueIds: item.candidateCueIds.filter((id) => id !== cueId) }))
    }

    // 该日志条目原先已配给另一条 Cue：旧 Cue 回到未配对栏
    const displacedPair = report.pairs.find((item) => item.entryId === entryId && item.cueId !== cueId)
    if (displacedPair) {
      const displacedCue = cueStore.cueById(displacedPair.cueId)
      if (displacedCue) {
        next.unmatchedCues = [
          ...next.unmatchedCues,
          {
            cueId: displacedCue.id,
            cueNo: displacedCue.cueNo,
            label: displacedCue.label,
            trigger: displacedCue.trigger,
            cueOrder: displacedPair.cueOrder,
            plannedTime: displacedPair.plannedTime,
            candidateEntryIds: report.candidates
              .filter((candidate) => candidate.cueId === displacedCue.id)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map((candidate) => candidate.entryId)
          }
        ].sort((a, b) => a.cueOrder - b.cueOrder)
      }
    }

    await db.reconcileReports.put(next)
    replaceReport(next)
    return next
  }

  /** 撤销一条已确认配对，退回两栏（候选清单保持不变） */
  async function unconfirmPair(reportId: string, cueId: string): Promise<ReconcileReport | null> {
    const report = reportById(reportId)
    if (!report) return null
    const cueStore = useCueStore()
    const cue = cueStore.cueById(cueId)
    const pair = report.pairs.find((item) => item.cueId === cueId)
    if (!cue || !pair) return report

    const unmatchedCue: UnmatchedCue = {
      cueId: cue.id,
      cueNo: cue.cueNo,
      label: cue.label,
      trigger: cue.trigger,
      cueOrder: pair.cueOrder,
      plannedTime: pair.plannedTime,
      candidateEntryIds: report.candidates
        .filter((candidate) => candidate.cueId === cueId)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((candidate) => candidate.entryId)
    }

    const entries = await db.logEntries.get(pair.entryId)
    const unmatchedLogRank = entries
      ? await db.logEntries
          .where('[logId+lineNo]')
          .between([report.logId, Dexie.minKey], [report.logId, entries.lineNo])
          .count()
      : 0
    const unmatchedLog: UnmatchedLog | null = entries
      ? {
          entryId: entries.id,
          logSeq: unmatchedLogRank,
          cueNo: entries.cueNo,
          actualTime: entries.timeOfDayMs === null ? null : msToClock(entries.timeOfDayMs),
          triggerKind: entries.triggerKind,
          message: entries.message,
          lineNo: entries.lineNo,
          candidateCueIds: report.candidates
            .filter((candidate) => candidate.entryId === entries.id)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((candidate) => candidate.cueId)
        }
      : null

    const next: ReconcileReport = {
      ...report,
      pairs: report.pairs.filter((item) => item.cueId !== cueId),
      unmatchedCues: [...report.unmatchedCues.filter((item) => item.cueId !== cueId), unmatchedCue].sort(
        (a, b) => a.cueOrder - b.cueOrder
      ),
      unmatchedLogs: unmatchedLog
        ? [...report.unmatchedLogs.filter((item) => item.entryId !== unmatchedLog.entryId), unmatchedLog].sort(
            (a, b) => a.logSeq - b.logSeq
          )
        : report.unmatchedLogs
    }
    await db.reconcileReports.put(next)
    replaceReport(next)
    return next
  }

  async function removeReport(id: string): Promise<void> {
    await db.reconcileReports.delete(id)
    reports.value = reports.value.filter((report) => report.id !== id)
  }

  /** 删除日志并级联条目与对账报告 */
  async function removeLog(logId: string): Promise<void> {
    await db.transaction('rw', [db.consoleLogs, db.logEntries, db.reconcileReports], async () => {
      await db.logEntries.where('logId').equals(logId).delete()
      await db.reconcileReports.where('logId').equals(logId).delete()
      await db.consoleLogs.delete(logId)
    })
    logs.value = logs.value.filter((log) => log.id !== logId)
    reports.value = reports.value.filter((report) => report.logId !== logId)
    fileHandles.delete(logId)
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const targets = logsOfSession(sessionId)
    if (targets.length === 0) return
    await db.transaction('rw', [db.consoleLogs, db.logEntries, db.reconcileReports], async () => {
      for (const log of targets) {
        await db.logEntries.where('logId').equals(log.id).delete()
        await db.reconcileReports.where('logId').equals(log.id).delete()
        fileHandles.delete(log.id)
      }
      await db.consoleLogs.where('sessionId').equals(sessionId).delete()
    })
    const ids = new Set(targets.map((log) => log.id))
    logs.value = logs.value.filter((log) => !ids.has(log.id))
    reports.value = reports.value.filter((report) => !ids.has(report.logId))
  }

  return {
    logs,
    reports,
    hydrated,
    running,
    logsSorted,
    reportsSorted,
    logById,
    reportById,
    reportsOfLog,
    latestReportOfLog,
    logsOfSession,
    hydrate,
    startImport,
    resumeImport,
    entriesPage,
    loadAllEntries,
    createReconcileReport,
    confirmCandidate,
    unconfirmPair,
    removeReport,
    removeLog,
    removeBySession
  }
})
