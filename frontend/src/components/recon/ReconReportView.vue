<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NStatistic, NTabPane, NTag, NTabs, useMessage } from 'naive-ui'
import VirtualList from '@/components/common/VirtualList.vue'
import PairRow from './PairRow.vue'
import UnmatchedCueRow from './UnmatchedCueRow.vue'
import { useReconStore, type ResolutionEntry } from '@/stores/reconStore'
import type { ConsoleLogEntry, LogEntryKind, ReconExtraLog, ReconPair, ReconReport } from '@/types/recon'
import { copyText, downloadTextFile, formatSignedSeconds } from '@/utils/export'
import { formatClock } from '@/utils/reconcile'
import { buildReconFilename, buildReconText } from '@/utils/reconExport'

const props = defineProps<{ report: ReconReport }>()
const emit = defineEmits<{ close: [] }>()

const message = useMessage()
const reconStore = useReconStore()

/** store 里的报告会被人工配对更新，始终取最新；被删除时回退到 prop 快照 */
const report = computed(() => reconStore.reportById(props.report.id) ?? props.report)

const tab = ref<'pairs' | 'cues' | 'logs' | 'gaps' | 'raw'>('pairs')
const busy = ref(false)

// ---------- 人工配对可选条目 ----------
function extraOptions(cueId: string): Array<{ label: string; value: string; entry: ResolutionEntry }> {
  const options: Array<{ label: string; value: string; entry: ResolutionEntry }> = report.value.extraLogs.map((extra) => ({
    label: `[${extra.timeText || '无时间'}] ${extra.cueNo ?? ''} ${extra.text}`.slice(0, 90),
    value: extra.entryId,
    entry: {
      id: extra.entryId,
      kind: extra.kind,
      cueNo: extra.cueNo,
      text: extra.text,
      time: extra.time,
      duplicateTime: extra.duplicateTime
    }
  }))
  // 已配在别的 Cue 上的日志也允许改配过来
  report.value.pairs.forEach((pair) => {
    if (pair.entryId && pair.cueId !== cueId) {
      options.push({
        label: `（已在 ${pair.cueNo}）[${formatClock(pair.actualTime)}] ${pair.entryText}`.slice(0, 90),
        value: pair.entryId,
        entry: {
          id: pair.entryId,
          kind: pair.entryKind ?? 'manual',
          cueNo: null,
          text: pair.entryText,
          time: pair.actualTime,
          duplicateTime: false
        }
      })
    }
  })
  return options
}

async function resolveCandidate(cueId: string, entryId: string): Promise<void> {
  const pair = report.value.pairs.find((item) => item.cueId === cueId)
  const candidate = pair?.candidates.find((item) => item.entryId === entryId)
  if (!candidate) return
  busy.value = true
  try {
    await reconStore.resolvePair(report.value.id, cueId, {
      id: candidate.entryId,
      kind: candidate.kind,
      cueNo: candidate.cueNo,
      text: candidate.text,
      time: candidate.time,
      duplicateTime: candidate.duplicateTime
    })
    message.success('已确认候选配对')
  } finally {
    busy.value = false
  }
}

async function resolveFromExtra(cueId: string, entry: ResolutionEntry): Promise<void> {
  busy.value = true
  try {
    await reconStore.resolvePair(report.value.id, cueId, entry)
    message.success('已完成人工配对')
  } finally {
    busy.value = false
  }
}

async function unresolve(cueId: string): Promise<void> {
  busy.value = true
  try {
    await reconStore.unresolvePair(report.value.id, cueId)
    message.info('已取消配对，条目回到未对上栏')
  } finally {
    busy.value = false
  }
}

// ---------- 虚拟列表的窗口加载 ----------
const pairLoader = async (startSeq: number, limit: number): Promise<ReconPair[]> =>
  report.value.pairs.slice(startSeq - 1, startSeq - 1 + limit)

interface UnmatchedCueRowData {
  cueId: string
  cueNo: string
  label: string
  planned: number | null
}
const unmatchedCueLoader = async (startSeq: number, limit: number): Promise<UnmatchedCueRowData[]> =>
  report.value.unmatchedCueIds.slice(startSeq - 1, startSeq - 1 + limit).map((cueId, offset) => {
    const index = startSeq - 1 + offset
    return {
      cueId,
      cueNo: report.value.unmatchedCueNos[index],
      label: report.value.unmatchedCueLabels[index],
      planned: report.value.plannedTimes[cueId] ?? null
    }
  })

const extraLoader = async (startSeq: number, limit: number): Promise<ReconExtraLog[]> =>
  report.value.extraLogs.slice(startSeq - 1, startSeq - 1 + limit)

const entryTotal = ref(0)
const entryLoader = async (startSeq: number, limit: number): Promise<ConsoleLogEntry[]> =>
  reconStore.loadEntryWindow(report.value.importId, startSeq, limit)

watch(
  () => report.value.importId,
  (importId) => {
    entryTotal.value = 0
    void reconStore.countEntries(importId).then((count) => {
      entryTotal.value = count
    })
  },
  { immediate: true }
)

// 每次报告结构变化后让虚拟列表重新对齐当前窗口
const pairReloadKey = computed(() => `${report.value.id}-${report.value.pairs.length}-${report.value.stats.candidates}`)
const cueReloadKey = computed(() => `${report.value.id}-${report.value.unmatchedCueIds.length}`)
const logReloadKey = computed(() => `${report.value.id}-${report.value.extraLogs.length}`)

function kindMeta(kind: LogEntryKind): { text: string; type: 'warning' | 'info' | 'default' } {
  if (kind === 'cue') return { text: 'Cue', type: 'info' }
  if (kind === 'manual') return { text: '手动补点', type: 'warning' }
  return { text: '日志', type: 'default' }
}

function handleCopy(): void {
  void copyText(buildReconText(report.value)).then((ok) => {
    if (ok) message.success('对账报告文本已复制')
    else message.error('复制失败，请改用下载')
  })
}

function handleDownload(): void {
  downloadTextFile(buildReconFilename(report.value.reportNo, report.value.generatedAt), buildReconText(report.value))
  message.success('已导出对账报告 .txt')
}
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    :title="`对账报告 · ${report.reportNo}（${report.sessionTitle}）`"
    class="recon-modal"
    :bordered="false"
    @update:show="(value: boolean) => !value && emit('close')"
  >
    <div class="recon-summary">
      <NStatistic label="Cue 总数" :value="report.stats.cueTotal" />
      <NStatistic label="对上" :value="report.stats.matched" />
      <NStatistic label="候选待确认" :value="report.stats.candidates" />
      <NStatistic label="未对上 Cue" :value="report.stats.unmatchedCues" />
      <NStatistic label="未对上日志" :value="report.stats.unmatchedLogs" />
      <NStatistic label="缺段" :value="report.stats.gaps" />
      <NStatistic
        label="偏差中位数"
        :value="report.stats.medianAbsDeviationSec === null ? '—' : formatSignedSeconds(report.stats.medianAbsDeviationSec)"
      />
    </div>
    <p class="recon-summary__sub muted">
      偏差晚为正、早为负；晚 {{ report.stats.lateCount }} 条 / 早 {{ report.stats.earlyCount }} 条。
      报告按生成时刻快照留档，之后修改 Cue 不影响本报告。
    </p>

    <NTabs v-model:value="tab" type="line" animated class="recon-tabs">
      <NTabPane name="pairs" :tab="`对上 / 候选 (${report.pairs.length})`">
        <VirtualList
          :total="report.pairs.length"
          :row-height="96"
          :overscan="6"
          :loader="pairLoader"
          :reload-key="pairReloadKey"
          empty-text="没有对上或候选条目"
        >
          <template #default="{ item }">
            <div class="pair-row">
              <PairRow
                :pair="(item as ReconPair)"
                :busy="busy"
                @confirm="resolveCandidate"
                @unresolve="unresolve"
              />
            </div>
          </template>
        </VirtualList>
      </NTabPane>

      <NTabPane name="cues" :tab="`未对上 Cue (${report.unmatchedCueIds.length})`">
        <VirtualList
          :total="report.unmatchedCueIds.length"
          :row-height="78"
          :overscan="8"
          :loader="unmatchedCueLoader"
          :reload-key="cueReloadKey"
          empty-text="所有 Cue 都已对上"
        >
          <template #default="{ item }">
            <div class="unmatched-row">
              <UnmatchedCueRow
                v-if="item as UnmatchedCueRowData"
                :cue-id="(item as UnmatchedCueRowData).cueId"
                :cue-no="(item as UnmatchedCueRowData).cueNo"
                :label="(item as UnmatchedCueRowData).label"
                :planned="(item as UnmatchedCueRowData).planned"
                :options="extraOptions((item as UnmatchedCueRowData).cueId)"
                :busy="busy"
                @pair="resolveFromExtra"
              />
            </div>
          </template>
        </VirtualList>
      </NTabPane>

      <NTabPane name="logs" :tab="`未对上日志 (${report.extraLogs.length})`">
        <VirtualList
          :total="report.extraLogs.length"
          :row-height="38"
          :overscan="12"
          :loader="extraLoader"
          :reload-key="logReloadKey"
          empty-text="没有未对上的日志"
        >
          <template #default="{ item }">
            <div v-if="item as ReconExtraLog" class="extra-row">
              <span class="extra-row__time mono">{{ (item as ReconExtraLog).timeText || '无时间戳' }}</span>
              <NTag size="tiny" :type="kindMeta((item as ReconExtraLog).kind).type" :bordered="false">
                {{ kindMeta((item as ReconExtraLog).kind).text }}
              </NTag>
              <span v-if="(item as ReconExtraLog).cueNo" class="extra-row__no mono">
                {{ (item as ReconExtraLog).cueNo }}
              </span>
              <span class="extra-row__text">{{ (item as ReconExtraLog).text }}</span>
              <NTag v-if="(item as ReconExtraLog).duplicateTime" size="tiny" type="warning" :bordered="false">
                重复时间戳
              </NTag>
            </div>
          </template>
        </VirtualList>
      </NTabPane>

      <NTabPane name="gaps" :tab="`日志缺段 (${report.gaps.length})`">
        <div v-if="report.gaps.length === 0" class="recon-empty">
          未发现超过 {{ report.gapThresholdSec }} 秒的日志缺段。
        </div>
        <div v-else class="gap-list">
          <div v-for="(gap, index) in report.gaps" :key="index" class="gap-row">
            <div class="gap-row__times mono">
              <span>{{ formatClock(gap.fromTime) }}</span>
              <span class="gap-row__arrow">{{ Math.round(gap.gapSec) }}s 无日志</span>
              <span>{{ formatClock(gap.toTime) }}</span>
            </div>
            <div class="gap-row__texts">
              <span>{{ gap.fromText }}</span>
              <span class="muted">→</span>
              <span>{{ gap.toText }}</span>
            </div>
          </div>
        </div>
      </NTabPane>

      <NTabPane name="raw" :tab="`原始日志 (${entryTotal})`">
        <VirtualList
          :total="entryTotal"
          :row-height="32"
          :overscan="16"
          :loader="entryLoader"
          :reload-key="report.importId"
          empty-text="没有日志条目"
        >
          <template #default="{ item }">
            <div v-if="item as ConsoleLogEntry" class="raw-row">
              <span class="raw-row__seq mono">{{ (item as ConsoleLogEntry).seq }}</span>
              <span class="raw-row__time mono">{{ (item as ConsoleLogEntry).timeText || '—' }}</span>
              <NTag size="tiny" :type="kindMeta((item as ConsoleLogEntry).kind).type" :bordered="false">
                {{ kindMeta((item as ConsoleLogEntry).kind).text }}
              </NTag>
              <span v-if="(item as ConsoleLogEntry).cueNo" class="raw-row__no mono">
                {{ (item as ConsoleLogEntry).cueNo }}
              </span>
              <span class="raw-row__text">{{ (item as ConsoleLogEntry).text }}</span>
              <NTag v-if="(item as ConsoleLogEntry).duplicateTime" size="tiny" type="warning" :bordered="false">
                重复时间戳
              </NTag>
            </div>
          </template>
        </VirtualList>
      </NTabPane>
    </NTabs>

    <template #footer>
      <div class="recon-footer">
        <NButton @click="emit('close')">关闭</NButton>
        <span style="flex: 1" />
        <NButton quaternary @click="handleCopy">复制文本</NButton>
        <NButton type="primary" @click="handleDownload">下载报告 .txt</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.recon-modal {
  width: 1020px;
  max-width: 96vw;
}

.recon-summary {
  display: flex;
  gap: 26px;
  flex-wrap: wrap;
  padding: 10px 4px 14px;
}

.recon-summary__sub {
  margin: 0 0 8px;
  font-size: 12px;
}

.recon-tabs {
  min-height: 460px;
}

.recon-empty {
  padding: 30px;
  text-align: center;
  color: rgba(255, 255, 255, 0.35);
  font-size: 13px;
}

.pair-row {
  padding: 8px 12px;
  margin: 0 6px 6px 0;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.unmatched-row {
  padding: 8px 12px;
  margin: 0 6px 6px 0;
  border-radius: 10px;
  background: rgba(232, 130, 109, 0.05);
  border: 1px solid rgba(232, 130, 109, 0.18);
}

.extra-row,
.raw-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0 12px;
  font-size: 12px;
}

.extra-row__time,
.raw-row__time {
  color: rgba(255, 255, 255, 0.6);
  min-width: 76px;
}

.raw-row__seq {
  color: rgba(255, 255, 255, 0.3);
  min-width: 52px;
}

.extra-row__no,
.raw-row__no {
  color: #f2b544;
  min-width: 48px;
}

.extra-row__text,
.raw-row__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gap-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gap-row {
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(232, 130, 109, 0.05);
  border: 1px solid rgba(232, 130, 109, 0.18);
}

.gap-row__times {
  display: flex;
  align-items: center;
  gap: 14px;
  color: #e8826d;
  font-size: 13px;
}

.gap-row__arrow {
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
}

.gap-row__texts {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.recon-footer {
  display: flex;
  gap: 10px;
}
</style>
