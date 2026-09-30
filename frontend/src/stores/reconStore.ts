import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ConsoleLogEntry,
  LogEntryKind,
  LogImport,
  ReconReport
} from '@/types/recon'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { flushCarry, parseLogChunk, resolveLogDateMs, todayLogDate } from '@/utils/logParse'
import { applyResolution, reconcile, unpair, type ReconEntry, type ReconcileResult } from '@/utils/reconcile'
import { useCueStore } from '@/stores/cueStore'
import { useSessionStore } from '@/stores/sessionStore'

/** 文件读取块大小（字节），约 256KB */
const FILE_CHUNK_BYTES = 256 * 1024
/** 每批落库的日志条目数 */
const ENTRY_FLUSH_SIZE = 300

/** 运行中的导入进度（同一时刻只跑一个） */
export interface ImportProgress {
  importId: string
  doneBytes: number
  totalBytes: number
  lineCount: number
  phase: 'reading' | 'flushing' | 'finishing'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 下一张对账报告当天序号 */
function nextReportNo(reports: readonly ReconReport[], generatedAt: Date): string {
  const prefix = `RC-${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}-`
  const used = reports
    .filter((report) => report.reportNo.startsWith(prefix))
    .map((report) => Number.parseInt(report.reportNo.slice(prefix.length), 10))
    .filter((value) => Number.isFinite(value))
  return `${prefix}${pad(used.length === 0 ? 1 : Math.max(...used) + 1)}`
}

/** 人工改配时页面提交的日志快照 */
export interface ResolutionEntry {
  id: string
  kind: LogEntryKind
  cueNo: string | null
  text: string
  time: number | null
  duplicateTime: boolean
}

/**
 * 灯控台日志对账仓库：
 * - 导入任务按字节偏移持久化，暂停 / 失败 / 关页面后可从断点继续
 * - 日志条目分批解析、分批落库，长日志不卡页面
 * - 报告保存生成时刻结果，之后修改 Cue 不影响历史（排演表照旧快照留档）
 */
export const useReconStore = defineStore('recon', () => {
  const imports = ref<LogImport[]>([])
  const reports = ref<ReconReport[]>([])
  const hydrated = ref(false)

  /** 当前运行中的导入句柄（取消用） */
  let runningHandle: { importId: string; cancel: () => void } | null = null
  const progress = ref<ImportProgress | null>(null)

  const reportsSorted = computed(() =>
    [...reports.value].sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  )

  function importsOfSession(sessionId: string): LogImport[] {
    return imports.value
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function importById(id: string): LogImport | null {
    return imports.value.find((item) => item.id === id) ?? null
  }

  function reportsOfSession(sessionId: string): ReconReport[] {
    return reportsSorted.value.filter((report) => report.sessionId === sessionId)
  }

  function reportById(id: string): ReconReport | null {
    return reports.value.find((report) => report.id === id) ?? null
  }

  async function hydrate(): Promise<void> {
    const [importList, reportList] = await Promise.all([db.logImports.toArray(), db.reconReports.toArray()])
    // 上次解析中断在「解析中」状态（关页面 / 刷新）：转为暂停，等用户重新选文件续传
    const now = Date.now()
    const interrupted = importList.filter((item) => item.status === 'parsing')
    if (interrupted.length > 0) {
      interrupted.forEach((item) => {
        item.status = 'paused'
        item.lastError = item.lastError || '页面关闭或刷新，已保留进度，可从断点继续'
        item.updatedAt = now
      })
      await db.logImports.bulkPut(interrupted)
    }
    imports.value = importList
    reports.value = reportList
    hydrated.value = true
  }

  /** 新建导入任务（此时还没有读文件） */
  async function createImport(input: { sessionId: string; fileName: string; fileSize: number; logDate?: string }): Promise<LogImport> {
    const now = Date.now()
    const record: LogImport = {
      id: createId('logimp'),
      sessionId: input.sessionId,
      fileName: input.fileName,
      fileSize: input.fileSize,
      logDate: input.logDate ?? todayLogDate(),
      status: 'paused',
      offset: 0,
      lineCount: 0,
      triggerCount: 0,
      lastError: '',
      createdAt: now,
      updatedAt: now
    }
    await db.logImports.put(record)
    imports.value = [...imports.value, record]
    return record
  }

  /** 落库一批条目并推进断点（同事务，保证进度与数据一致） */
  async function flushBatch(
    record: LogImport,
    entries: ConsoleLogEntry[],
    offset: number,
    status: LogImport['status'],
    extra?: Partial<Pick<LogImport, 'lastError'>>
  ): Promise<void> {
    const now = Date.now()
    const next: LogImport = {
      ...record,
      offset,
      lineCount: record.lineCount + entries.length,
      triggerCount: record.triggerCount + entries.filter((entry) => entry.kind !== 'info').length,
      status,
      updatedAt: now,
      lastError: extra?.lastError ?? (status === 'failed' ? record.lastError : '')
    }
    await db.transaction('rw', db.logEntries, db.logImports, async () => {
      if (entries.length > 0) await db.logEntries.bulkPut(entries)
      await db.logImports.put(next)
    })
    Object.assign(record, next)
    syncImportRecord(record)
  }

  function syncImportRecord(record: LogImport): void {
    imports.value = imports.value.map((item) => (item.id === record.id ? { ...record } : item))
  }

  /**
   * 从断点开始（或继续）解析文件。
   * 新导入 offset 为 0；续传要求同一文件（文件名 / 大小一致）。
   */
  async function runImport(importId: string, file: File): Promise<{ ok: boolean; done: boolean; message?: string }> {
    const record = importById(importId)
    if (!record) return { ok: false, done: false, message: '导入任务不存在' }
    if (runningHandle) return { ok: false, done: false, message: '已有日志正在导入，请稍候' }
    if (record.status === 'done') return { ok: true, done: true }
    if (file.name !== record.fileName || file.size !== record.fileSize) {
      return { ok: false, done: false, message: '所选文件与原文件不一致（文件名或大小不同），无法从断点续传' }
    }

    const baseDateMs = resolveLogDateMs(record.logDate)
    let byteOffset = record.offset
    let seq = record.lineCount
    let cancelled = false

    // 声明在 try 外：catch 时仍能把已解析条目落到安全断点
    let pending: ConsoleLogEntry[] = []
    let safeOffset = record.offset

    // 续传时用已落库最后一条的时间播种，重复时间戳判定不跨断点丢失
    let prevTime: number | null = null
    if (record.lineCount > 0) {
      const last = await db.logEntries
        .where('[importId+seq]')
        .between([record.id, record.lineCount], [record.id, Number.MAX_SAFE_INTEGER])
        .first()
      prevTime = last?.time ?? null
    }

    const handle = {
      importId,
      cancel: () => {
        cancelled = true
      }
    }
    runningHandle = handle
    progress.value = { importId, doneBytes: byteOffset, totalBytes: file.size, lineCount: seq, phase: 'reading' }

    // 标记解析中（断点已在各批次落库，崩溃也只会回到上一批）
    const active: LogImport = { ...record, status: 'parsing', lastError: '', updatedAt: Date.now() }
    await db.logImports.put(active)
    Object.assign(record, active)
    syncImportRecord(record)

    try {
      // 在原始字节上按换行切分：\n(0x0A) 不会是 UTF-8 多字节字符的任何一个字节，
      // 所以换行边界天然是字符边界，断点既不落在半个字中间，decoder 也无内部残留
      const decoder = new TextDecoder('utf-8')
      let byteCarry = new Uint8Array(0)

      const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
        const merged = new Uint8Array(a.length + b.length)
        merged.set(a, 0)
        merged.set(b, a.length)
        return merged
      }

      while (byteOffset < file.size) {
        if (cancelled) break
        const slice = file.slice(byteOffset, Math.min(byteOffset + FILE_CHUNK_BYTES, file.size))
        const buffer = await slice.arrayBuffer()
        byteOffset += buffer.byteLength
        byteCarry = concatBytes(byteCarry, new Uint8Array(buffer))

        // 找最后一个换行（\n = 0x0A）
        let cut = -1
        for (let i = byteCarry.length - 1; i >= 0; i -= 1) {
          if (byteCarry[i] === 0x0a) {
            cut = i + 1
            break
          }
        }

        let completedText = ''
        if (cut >= 0) {
          completedText = decoder.decode(byteCarry.subarray(0, cut), { stream: false })
          byteCarry = byteCarry.slice(cut)
        }
        // 整块还没有换行：全部留在 carry，等下一块拼上来
        safeOffset = byteOffset - byteCarry.byteLength

        if (completedText) {
          // 整段由完整行组成，逐行解析（不依赖跨块文本 carry）
          const batch = parseLogChunk(completedText, '', baseDateMs)
          batch.lines.forEach((line) => {
            seq += 1
            const duplicateTime = line.time !== null && prevTime !== null && line.time === prevTime
            if (line.time !== null) prevTime = line.time
            pending.push({
              id: `${importId}_${seq}`,
              importId,
              sessionId: record.sessionId,
              seq,
              time: line.time,
              timeText: line.timeText,
              kind: line.kind,
              cueNo: line.cueNo,
              text: line.text,
              raw: '',
              duplicateTime
            })
          })
        }

        progress.value = { importId, doneBytes: safeOffset, totalBytes: file.size, lineCount: seq, phase: 'reading' }

        if (pending.length >= ENTRY_FLUSH_SIZE) {
          progress.value = { ...progress.value, phase: 'flushing' }
          await flushBatch(record, pending, safeOffset, 'parsing')
          pending = []
          seq = record.lineCount
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }

      if (cancelled) {
        // 暂停：只落完整行，断点停在最后一个完整字符 / 换行边界，半行下次重新解析
        await flushBatch(record, pending, safeOffset, 'paused', { lastError: '已手动暂停，进度已保留，可从断点继续' })
        return { ok: true, done: false }
      }

      // 正常结束：冲刷没有结尾换行的最后半行（此时 byteCarry 必为完整字符）
      const tailText = byteCarry.byteLength > 0 ? decoder.decode(byteCarry, { stream: false }) : ''
      const tail = tailText ? flushCarry(tailText, baseDateMs) : null
      if (tail) {
        seq += 1
        const duplicateTime = tail.time !== null && prevTime !== null && tail.time === prevTime
        pending.push({
          id: `${importId}_${seq}`,
          importId,
          sessionId: record.sessionId,
          seq,
          time: tail.time,
          timeText: tail.timeText,
          kind: tail.kind,
          cueNo: tail.cueNo,
          text: tail.text,
          raw: '',
          duplicateTime
        })
      }
      progress.value = { importId, doneBytes: file.size, totalBytes: file.size, lineCount: record.lineCount + pending.length, phase: 'finishing' }
      await flushBatch(record, pending, file.size, 'done')
      return { ok: true, done: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 失败也把已解析的完整行落到安全断点，之后从该点重试
      await flushBatch(record, pending, safeOffset, 'failed', {
        lastError: `导入中断：${message}（进度已保留，可从断点重试）`
      }).catch(() => undefined)
      return { ok: false, done: false, message }
    } finally {
      runningHandle = null
      progress.value = null
    }
  }

  /** 请求暂停当前导入（当前文件块读完后停） */
  function pauseRunning(): void {
    runningHandle?.cancel()
  }

  /** 删除导入任务及其全部条目与报告 */
  async function removeImport(importId: string): Promise<void> {
    if (runningHandle?.importId === importId) runningHandle.cancel()
    const reportIds = reports.value.filter((report) => report.importId === importId).map((report) => report.id)
    await db.transaction('rw', db.logEntries, db.logImports, db.reconReports, async () => {
      await db.logEntries.where('importId').equals(importId).delete()
      await db.logImports.delete(importId)
      if (reportIds.length > 0) await db.reconReports.bulkDelete(reportIds)
    })
    imports.value = imports.value.filter((item) => item.id !== importId)
    reports.value = reports.value.filter((report) => report.importId !== importId)
  }

  /** 原始日志条目总数（虚拟列表用） */
  async function countEntries(importId: string): Promise<number> {
    return db.logEntries.where('importId').equals(importId).count()
  }

  /** 窗口式读取原始日志条目（按行号升序），长日志不一次性入内存 */
  async function loadEntryWindow(importId: string, offsetSeq: number, limit: number): Promise<ConsoleLogEntry[]> {
    return db.logEntries
      .where('[importId+seq]')
      .between([importId, offsetSeq], [importId, Number.MAX_SAFE_INTEGER])
      .limit(limit)
      .toArray()
  }

  /**
   * 分批读取触发条目并执行对账，批次间让出主线程。
   * 解析是逐批纯计算 + 单次落库，页面不会卡死。
   */
  async function generateReport(input: {
    importId: string
    gapThresholdSec: number
    note?: string
  }): Promise<ReconReport | { error: string }> {
    const record = importById(input.importId)
    if (!record) return { error: '导入任务不存在' }
    if (record.status !== 'done') return { error: '日志尚未导入完成，无法对账' }

    const cueStore = useCueStore()
    const sessionStore = useSessionStore()
    const session = sessionStore.sessionById(record.sessionId)
    if (!session) return { error: '所属场次已删除' }
    const cues = cueStore.sortedCuesOfSession(record.sessionId)
    if (cues.length === 0) return { error: '该场次还没有 Cue，无法对账' }

    const baseDateMs = resolveLogDateMs(record.logDate)
    const projected: ReconEntry[] = []

    // 按复合索引 [importId+seq] 升序遍历，批次间让出主线程（长日志不卡页面）
    await db.logEntries
      .where('[importId+seq]')
      .between([input.importId, 0], [input.importId, Number.MAX_SAFE_INTEGER])
      .each(async (entry) => {
        projected.push({
          id: entry.id,
          seq: entry.seq,
          time: entry.time,
          kind: entry.kind,
          cueNo: entry.cueNo,
          text: entry.text,
          duplicateTime: entry.duplicateTime
        })
        if (projected.length % ENTRY_FLUSH_SIZE === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      })

    const result: ReconcileResult = reconcile({
      cues,
      entries: projected,
      plannedStart: session.plannedStart,
      baseDateMs,
      gapThresholdSec: input.gapThresholdSec
    })

    const generatedAt = new Date()
    const report: ReconReport = {
      id: createId('recon'),
      sessionId: record.sessionId,
      importId: input.importId,
      reportNo: nextReportNo(reports.value, generatedAt),
      generatedAt: generatedAt.toISOString(),
      note: input.note?.trim() ?? '',
      sessionTitle: `${session.order}. ${session.title}`,
      gapThresholdSec: input.gapThresholdSec,
      pairs: result.pairs,
      unmatchedCueIds: result.unmatchedCueIds,
      unmatchedCueNos: result.unmatchedCueNos,
      unmatchedCueLabels: result.unmatchedCueLabels,
      extraLogs: result.extraLogs,
      gaps: result.gaps,
      plannedTimes: result.plannedTimes,
      stats: result.stats
    }

    await db.reconReports.put(report)
    reports.value = [...reports.value, report]
    return report
  }

  async function removeReport(id: string): Promise<void> {
    await db.reconReports.delete(id)
    reports.value = reports.value.filter((report) => report.id !== id)
  }

  /** 人工确认候选 / 改配：把指定日志条目配到指定 Cue */
  async function resolvePair(reportId: string, cueId: string, entry: ResolutionEntry): Promise<void> {
    const report = reportById(reportId)
    if (!report) return
    const cueStore = useCueStore()
    const liveCue = cueStore.cueById(cueId)
    const next: ReconReport = structuredClone(report)
    applyResolution(next, cueId, entry, liveCue ? { cueNo: liveCue.cueNo, label: liveCue.label } : undefined)
    await db.reconReports.put(next)
    reports.value = reports.value.map((item) => (item.id === reportId ? next : item))
  }

  /** 取消配对：Cue 与日志回到各自的「未对上」栏 */
  async function unresolvePair(reportId: string, cueId: string): Promise<void> {
    const report = reportById(reportId)
    if (!report) return
    const next: ReconReport = structuredClone(report)
    unpair(next, cueId)
    await db.reconReports.put(next)
    reports.value = reports.value.map((item) => (item.id === reportId ? next : item))
  }

  /** 删除场次时的级联清理 */
  async function removeBySession(sessionId: string): Promise<void> {
    const targetImports = imports.value.filter((item) => item.sessionId === sessionId)
    if (targetImports.length === 0) return
    const importIds = targetImports.map((item) => item.id)
    await db.transaction('rw', db.logEntries, db.logImports, db.reconReports, async () => {
      for (const importId of importIds) {
        await db.logEntries.where('importId').equals(importId).delete()
      }
      await db.logImports.bulkDelete(importIds)
      await db.reconReports.where('sessionId').equals(sessionId).delete()
    })
    imports.value = imports.value.filter((item) => item.sessionId !== sessionId)
    reports.value = reports.value.filter((report) => report.sessionId !== sessionId)
  }

  return {
    imports,
    reports,
    hydrated,
    progress,
    reportsSorted,
    importsOfSession,
    importById,
    reportsOfSession,
    reportById,
    hydrate,
    createImport,
    runImport,
    pauseRunning,
    removeImport,
    countEntries,
    loadEntryWindow,
    generateReport,
    removeReport,
    resolvePair,
    unresolvePair,
    removeBySession
  }
})
