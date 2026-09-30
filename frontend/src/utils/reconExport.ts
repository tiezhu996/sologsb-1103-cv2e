import type { ReconReport } from '@/types/recon'
import { formatDateTime } from '@/utils/fade'
import { formatSignedSeconds } from '@/utils/export'
import { formatClock } from '@/utils/reconcile'

/** 对账报告纯文本拼装，用于复制与导出 */
export function buildReconText(report: ReconReport): string {
  const lines: string[] = []
  lines.push('================ 灯控台日志对账报告 ================')
  lines.push(`报告编号：${report.reportNo}`)
  lines.push(`场次：${report.sessionTitle}`)
  lines.push(`生成时间：${formatDateTime(report.generatedAt)}`)
  lines.push(`缺段阈值：${report.gapThresholdSec}s`)
  if (report.note) lines.push(`备注：${report.note}`)
  const { stats } = report
  lines.push(
    `汇总：Cue ${stats.cueTotal} 条 · 对上 ${stats.matched} · 候选 ${stats.candidates} · ` +
      `未对上 Cue ${stats.unmatchedCues} · 未对上日志 ${stats.unmatchedLogs} · 缺段 ${stats.gaps}`
  )
  if (stats.medianAbsDeviationSec !== null) {
    lines.push(
      `偏差：中位数 ${formatSignedSeconds(stats.medianAbsDeviationSec)}（晚 ${stats.lateCount} 条 / 早 ${stats.earlyCount} 条，均取绝对值）`
    )
  }
  lines.push('')

  lines.push('—— 已对上 / 候选（按 Cue 顺序）——')
  if (report.pairs.length === 0) {
    lines.push('（无）')
  } else {
    report.pairs.forEach((pair) => {
      const flag = pair.status === 'candidate' ? '〔候选〕' : '〔对上〕'
      lines.push(
        `${flag} ${pair.cueNo} ${pair.label || '（无提示语）'}    计划 ${formatClock(pair.plannedTime)}` +
          ` → 实际 ${pair.actualTime !== null ? formatClock(pair.actualTime) : '（无时间戳）'}` +
          `    偏差 ${formatSignedSeconds(pair.deviationSec)}`
      )
      lines.push(`        依据：${pair.matchReason}`)
      pair.candidates.forEach((candidate) => {
        lines.push(
          `        候选 ${candidate.score} 分（${candidate.reason}）：${candidate.cueNo ?? ''} ${candidate.text}` +
            `${candidate.time !== null ? ` @${formatClock(candidate.time)}` : ''}`
        )
      })
    })
  }
  lines.push('')

  lines.push('—— 未对上的 Cue ——')
  if (report.unmatchedCueIds.length === 0) {
    lines.push('（无）')
  } else {
    report.unmatchedCueIds.forEach((_, index) => {
      lines.push(`  ${report.unmatchedCueNos[index]} ${report.unmatchedCueLabels[index] || '（无提示语）'}`)
    })
  }
  lines.push('')

  lines.push('—— 未对上的日志 ——')
  if (report.extraLogs.length === 0) {
    lines.push('（无）')
  } else {
    report.extraLogs.forEach((extra) => {
      lines.push(
        `  [${extra.timeText || '无时间戳'}] ${extra.kind === 'manual' ? '手动补点' : '触发'} ` +
          `${extra.cueNo ?? ''} ${extra.text}${extra.duplicateTime ? '（重复时间戳）' : ''}`
      )
    })
  }
  lines.push('')

  lines.push('—— 日志缺段 ——')
  if (report.gaps.length === 0) {
    lines.push('（无）')
  } else {
    report.gaps.forEach((gap) => {
      lines.push(
        `  ${formatClock(gap.fromTime)} ${gap.fromText}  →  ${formatClock(gap.toTime)} ${gap.toText}（断档 ${Math.round(gap.gapSec)}s）`
      )
    })
  }

  lines.push('')
  lines.push('—— 由剧场灯光 Cue 表编排器（gbcuesheet）生成 ——')
  return lines.join('\n')
}

/** 对账报告导出文件名 */
export function buildReconFilename(reportNo: string, generatedAt: string): string {
  const date = new Date(generatedAt)
  const stamp = Number.isNaN(date.getTime())
    ? generatedAt.replace(/[^\d]/g, '').slice(0, 14)
    : `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  return `对账报告_${reportNo.replace(/[^\w-]/g, '_')}_${stamp}.txt`
}
