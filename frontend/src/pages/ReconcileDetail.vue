<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NEmpty, NProgress, NTag, useDialog, useMessage } from 'naive-ui'
import {
  deviationSummary,
  formatDeviation
} from '@/utils/reconcile'
import { useCueStore } from '@/stores/cueStore'
import { useLogStore } from '@/stores/logStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { ConsoleLogEntry } from '@/types/log'
import type { MatchCandidate, MatchedPair, ReconcileReport } from '@/types/reconcile'
import { formatDateTime } from '@/utils/fade'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const cueStore = useCueStore()
const logStore = useLogStore()
const sessionStore = useSessionStore()

const logId = computed(() => String(route.params.id ?? ''))
const log = computed(() => logStore.logById(logId.value) ?? null)

const reconciling = ref(false)
const reconcileProgress = ref(0)
const reconcilePhase = ref<'query' | 'reconcile'>('reconcile')

/** 当前报告由 store 提供（人工裁决后自动刷新） */
const report = computed<ReconcileReport | null>(() => logStore.latestReportOfLog(logId.value))

/** 原始触发条目分批加载（仅展开 / 无报告时使用，避免长日志一次性渲染） */
const rawEntries = ref<ConsoleLogEntry[]>([])
const rawPage = ref(0)
const rawLoading = ref(false)
const RAW_PAGE_SIZE = 100

/** 候选行的展开状态：`${cueId}::${entryId}` */
const expandedCue = ref<string | null>(null)
const expandedLog = ref<string | null>(null)

const session = computed(() => (log.value ? sessionStore.sessionById(log.value.sessionId) : null))

const summary = computed(() => (report.value ? deviationSummary(report.value.pairs) : null))

const matchedPairs = computed(() => report.value?.pairs ?? [])
const unmatchedCues = computed(() => report.value?.unmatchedCues ?? [])
const unmatchedLogs = computed(() => report.value?.unmatchedLogs ?? [])

const hasTimeData = computed(() => matchedPairs.value.some((pair) => pair.deviationSec !== null))

function candidatesForCue(cueId: string): MatchCandidate[] {
  if (!report.value) return []
  return report.value.candidates
    .filter((candidate) => candidate.cueId === cueId)
    .sort((a, b) => b.score - a.score)
}

function candidatesForLog(entryId: string): MatchCandidate[] {
  if (!report.value) return []
  return report.value.candidates
    .filter((candidate) => candidate.entryId === entryId)
    .sort((a, b) => b.score - a.score)
}

function cueLabel(cueId: string): string {
  return cueStore.cueById(cueId)?.label ?? '（Cue 已删除）'
}

function reasonTag(reason: MatchCandidate['reasons'][number]): { text: string; type: 'success' | 'info' | 'warning' } {
  if (reason === 'cueNo') return { text: '编号', type: 'success' }
  if (reason === 'label') return { text: '提示语', type: 'info' }
  return { text: '顺序', type: 'warning' }
}

function kindTag(kind: ConsoleLogEntry['triggerKind']): { text: string; type: 'default' | 'success' | 'warning' | 'error' } {
  switch (kind) {
    case 'go':
      return { text: 'GO', type: 'success' }
    case 'manual':
      return { text: '手动', type: 'warning' }
    case 'auto':
      return { text: '自动', type: 'default' }
    default:
      return { text: '未知', type: 'error' }
  }
}

function deviationType(sec: number | null): 'success' | 'warning' | 'error' | 'default' {
  if (sec === null) return 'default'
  const abs = Math.abs(sec)
  if (abs <= 2) return 'success'
  if (abs <= 30) return 'warning'
  return 'error'
}

async function runReconcile(): Promise<void> {
  if (!log.value || reconciling.value) return
  reconciling.value = true
  reconcileProgress.value = 0
  try {
    await logStore.createReconcileReport(log.value.id, (progress) => {
      reconcileProgress.value = progress.ratio
      reconcilePhase.value = progress.phase === 'read' ? 'reconcile' : progress.phase
    })
    message.success('对账完成')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '对账失败')
  } finally {
    reconciling.value = false
  }
}

async function confirmPair(cueId: string, entryId: string): Promise<void> {
  if (!report.value) return
  await logStore.confirmCandidate(report.value.id, cueId, entryId)
  expandedCue.value = null
  expandedLog.value = null
  message.success('已确认配对')
}

async function unconfirm(pair: MatchedPair): Promise<void> {
  if (!report.value) return
  await logStore.unconfirmPair(report.value.id, pair.cueId)
  message.info('已撤销配对，条目退回候选')
}

async function loadRawPage(): Promise<void> {
  if (!log.value || rawLoading.value) return
  rawLoading.value = true
  try {
    const page = await logStore.entriesPage(log.value.id, rawPage.value * RAW_PAGE_SIZE, RAW_PAGE_SIZE)
    rawEntries.value = rawPage.value === 0 ? page : [...rawEntries.value, ...page]
    if (page.length === RAW_PAGE_SIZE) rawPage.value += 1
    else rawPage.value = -1
  } finally {
    rawLoading.value = false
  }
}

async function resetRaw(): Promise<void> {
  rawPage.value = 0
  rawEntries.value = []
  await loadRawPage()
}

function confirmDeleteReport(): void {
  if (!report.value) return
  const target = report.value
  dialog.warning({
    title: '删除对账结果',
    content: '仅删除本次配对结果（含人工裁决），不影响已导入的日志条目，可随时重新对账。',
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await logStore.removeReport(target.id)
      message.success('对账结果已删除')
    }
  })
}

function confirmDeleteLog(): void {
  if (!log.value) return
  const target = log.value
  dialog.warning({
    title: '删除日志',
    content: `将删除「${target.fileName}」及其全部触发条目与对账报告。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await logStore.removeLog(target.id)
      message.success('日志已删除')
      void router.push('/reconcile')
    }
  })
}

function goBack(): void {
  void router.push('/reconcile')
}

onMounted(() => {
  if (log.value && !report.value && log.value.entryCount > 0) {
    void runReconcile()
  }
  if (log.value && !report.value) void resetRaw()
})

watch(
  () => report.value?.id,
  () => {
    expandedCue.value = null
    expandedLog.value = null
  }
)
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">
          日志对账明细
          <span v-if="log" class="subtitle-inline mono">{{ log.fileName }}</span>
        </h1>
        <p class="page__subtitle">
          <template v-if="session">{{ session.order }}. {{ session.title }}</template>
          <template v-else>（场次已删除）</template>
          · 导入于 {{ log ? formatDateTime(log.importedAt) : '—' }}
          · 触发记录 {{ log?.entryCount ?? 0 }} 条
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goBack">返回列表</NButton>
        <NButton quaternary type="error" @click="confirmDeleteLog">删除日志</NButton>
      </div>
    </header>

    <NAlert v-if="!log" type="error" :bordered="false">
      日志不存在或已被删除。
      <NButton size="tiny" text type="primary" @click="goBack">返回对账列表</NButton>
    </NAlert>

    <NAlert v-else-if="log.status !== 'done'" type="warning" :bordered="false">
      该日志尚未完成导入（{{ Math.round((log.bytesOffset / Math.max(1, log.bytesTotal)) * 100) }}%）。
      请先在列表页从断点继续，完成后再进行对账。
    </NAlert>

    <template v-else>
      <!-- 对账进度 / 工具栏 -->
      <section class="panel">
        <div class="recon-toolbar">
          <div class="recon-toolbar__info">
            <template v-if="report">
              <span class="stat-chip"><b>{{ matchedPairs.length }}</b> 已配对</span>
              <span class="stat-chip warn"><b>{{ unmatchedCues.length }}</b> Cue 未触发</span>
              <span class="stat-chip warn"><b>{{ unmatchedLogs.length }}</b> 日志多余</span>
              <span v-if="summary" class="stat-chip">
                偏差：提前 {{ summary.early }} / 准时 {{ summary.onTime }} / 滞后 {{ summary.late }}
                · 平均 |偏差| {{ formatDeviation(summary.avgAbsSec) }}
              </span>
            </template>
            <span v-else class="muted">尚未生成对账结果</span>
          </div>
          <span class="toolbar__spacer" />
          <NButton v-if="report" size="small" quaternary type="error" @click="confirmDeleteReport">删除结果</NButton>
          <NButton type="primary" size="small" :loading="reconciling" @click="runReconcile">
            {{ report ? '重新对账' : '开始对账' }}
          </NButton>
        </div>
        <div v-if="reconciling" class="recon-progress">
          <NProgress
            type="line"
            :percentage="Math.round(reconcileProgress * 100)"
            :height="6"
            processing
            :indicator-placement="'inside'"
          />
          <span class="muted mono progress-label">
            {{ reconcilePhase === 'query' ? '分批读取日志条目…' : '分批比对编号 / 提示语 / 触发顺序…' }}
            （{{ Math.round(reconcileProgress * 100) }}%）
          </span>
        </div>
        <p v-if="report && !hasTimeData" class="recon-note muted">
          日志条目缺少可解析的时间戳，无法计算偏差；配对仍按编号、提示语与触发顺序完成。
        </p>
      </section>

      <!-- 已配对 -->
      <section class="panel">
        <h2 class="panel__title">
          已配对 Cue<span class="panel__title-tag">{{ matchedPairs.length }} 条 · 计划时刻 / 实际触发 / 偏差</span>
        </h2>
        <NEmpty v-if="matchedPairs.length === 0" description="还没有已确认的配对，可在下方两栏人工挑选候选" />
        <div v-else class="pair-table">
          <div class="pair-row pair-row--head">
            <span class="col-order">位次</span>
            <span class="col-no">Cue</span>
            <span class="col-label">提示语</span>
            <span class="col-kind">日志</span>
            <span class="col-time">计划时刻</span>
            <span class="col-time">实际触发</span>
            <span class="col-dev">偏差</span>
            <span class="col-actions"></span>
          </div>
          <div v-for="pair in matchedPairs" :key="pair.cueId" class="pair-row">
            <span class="col-order mono">{{ pair.cueOrder }} ↔ {{ pair.logSeq }}</span>
            <span class="col-no mono">{{ pair.cueNo }}</span>
            <span class="col-label" :title="pair.label">{{ pair.label || '（无提示语）' }}</span>
            <span class="col-kind">
              <NTag size="tiny" :type="kindTag(pair.logKind).type" :bordered="false">{{ kindTag(pair.logKind).text }}</NTag>
              <NTag v-for="reason in pair.reasons" :key="reason" size="tiny" :type="reasonTag(reason).type" :bordered="false">
                {{ reasonTag(reason).text }}
              </NTag>
            </span>
            <span class="col-time mono">{{ pair.plannedTime ?? '—' }}</span>
            <span class="col-time mono">{{ pair.actualTime ?? '缺时间戳' }}</span>
            <span class="col-dev">
              <NTag size="tiny" :type="deviationType(pair.deviationSec)" :bordered="false">
                {{ formatDeviation(pair.deviationSec) }}
              </NTag>
            </span>
            <span class="col-actions">
              <NButton size="tiny" quaternary @click="unconfirm(pair)">撤销</NButton>
            </span>
          </div>
        </div>
      </section>

      <!-- 未配对两栏 -->
      <section v-if="report" class="panel">
        <h2 class="panel__title">
          未对上的条目<span class="panel__title-tag">左：Cue 表有而日志无触发；右：日志多出的触发（手动补点 / 抢台词）</span>
        </h2>
        <div class="two-col">
          <!-- 未对上的 Cue -->
          <div class="col">
            <h3 class="col__head">未触发的 Cue（{{ unmatchedCues.length }}）</h3>
            <NEmpty v-if="unmatchedCues.length === 0" size="small" description="全部 Cue 均已对上" />
            <div
              v-for="cue in unmatchedCues"
              :key="cue.cueId"
              class="cue-item"
              :class="{ 'cue-item--open': expandedCue === cue.cueId }"
            >
              <button class="item-main" type="button" @click="expandedCue = expandedCue === cue.cueId ? null : cue.cueId">
                <span class="mono item-no">{{ cue.cueNo }}</span>
                <span class="item-label" :title="cue.label">{{ cue.label || '（无提示语）' }}</span>
                <NTag size="tiny" :bordered="false">{{ cue.trigger }}</NTag>
                <span class="mono muted item-plan">{{ cue.plannedTime ?? '—' }}</span>
                <span class="muted item-cand">{{ cue.candidateEntryIds.length }} 个候选</span>
              </button>
              <div v-if="expandedCue === cue.cueId" class="candidate-box">
                <NEmpty
                  v-if="candidatesForCue(cue.cueId).length === 0"
                  size="small"
                  description="没有可参考的日志候选，可能对应日志缺段"
                />
                <div v-for="candidate in candidatesForCue(cue.cueId)" :key="candidate.entryId" class="candidate-row">
                  <div class="candidate-row__main">
                    <span class="mono">#{{ candidate.logSeq }}</span>
                    <NTag size="tiny" :type="kindTag(candidate.logKind).type" :bordered="false">
                      {{ kindTag(candidate.logKind).text }}
                    </NTag>
                    <span v-if="candidate.logCueNo" class="mono candidate-no">{{ candidate.logCueNo }}</span>
                    <span class="candidate-msg" :title="candidate.logMessage">
                      {{ candidate.logMessage || '（无消息文本）' }}
                    </span>
                    <span class="mono muted">{{ candidate.actualTime ?? '—' }}</span>
                  </div>
                  <div class="candidate-row__meta">
                    <NTag size="tiny" :type="candidate.score >= 70 ? 'success' : 'warning'" :bordered="false">
                      把握度 {{ candidate.score }}
                    </NTag>
                    <NTag
                      v-for="reason in candidate.reasons"
                      :key="reason"
                      size="tiny"
                      :type="reasonTag(reason).type"
                      :bordered="false"
                    >
                      {{ reasonTag(reason).text }}
                    </NTag>
                    <span class="muted">位次差 {{ candidate.orderDistance }}</span>
                    <span class="mono muted">偏差 {{ formatDeviation(candidate.deviationSec) }}</span>
                    <span class="toolbar__spacer" />
                    <NButton size="tiny" type="primary" @click="confirmPair(cue.cueId, candidate.entryId)">
                      确认为此 Cue
                    </NButton>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 未对上的日志 -->
          <div class="col">
            <h3 class="col__head">多余的日志触发（{{ unmatchedLogs.length }}）</h3>
            <NEmpty v-if="unmatchedLogs.length === 0" size="small" description="日志没有多余触发" />
            <div
              v-for="entry in unmatchedLogs"
              :key="entry.entryId"
              class="log-item"
              :class="{ 'log-item--open': expandedLog === entry.entryId }"
            >
              <button
                class="item-main"
                type="button"
                @click="expandedLog = expandedLog === entry.entryId ? null : entry.entryId"
              >
                <span class="mono item-no">{{ entry.cueNo || `#${entry.logSeq}` }}</span>
                <NTag size="tiny" :type="kindTag(entry.triggerKind).type" :bordered="false">
                  {{ kindTag(entry.triggerKind).text }}
                </NTag>
                <span class="item-label" :title="entry.message">{{ entry.message || `日志第 ${entry.lineNo} 行` }}</span>
                <span class="mono muted item-plan">{{ entry.actualTime ?? '缺时间戳' }}</span>
                <span class="muted item-cand">{{ entry.candidateCueIds.length }} 个候选</span>
              </button>
              <div v-if="expandedLog === entry.entryId" class="candidate-box">
                <NEmpty v-if="candidatesForLog(entry.entryId).length === 0" size="small" description="没有可参考的 Cue 候选" />
                <div v-for="candidate in candidatesForLog(entry.entryId)" :key="candidate.cueId" class="candidate-row">
                  <div class="candidate-row__main">
                    <span class="mono">{{ candidate.cueNo }}</span>
                    <span class="candidate-msg" :title="cueLabel(candidate.cueId)">
                      {{ cueLabel(candidate.cueId) || '（无提示语）' }}
                    </span>
                    <span class="mono muted">{{ cueStore.cueById(candidate.cueId)?.trigger ?? '' }}</span>
                  </div>
                  <div class="candidate-row__meta">
                    <NTag size="tiny" :type="candidate.score >= 70 ? 'success' : 'warning'" :bordered="false">
                      把握度 {{ candidate.score }}
                    </NTag>
                    <NTag
                      v-for="reason in candidate.reasons"
                      :key="reason"
                      size="tiny"
                      :type="reasonTag(reason).type"
                      :bordered="false"
                    >
                      {{ reasonTag(reason).text }}
                    </NTag>
                    <span class="muted">位次差 {{ candidate.orderDistance }}</span>
                    <span class="mono muted">偏差 {{ formatDeviation(candidate.deviationSec) }}</span>
                    <span class="toolbar__spacer" />
                    <NButton size="tiny" type="primary" @click="confirmPair(candidate.cueId, entry.entryId)">
                      配到该 Cue
                    </NButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 原始日志（分批加载，长日志不卡页面） -->
      <section class="panel">
        <div class="raw-head">
          <h2 class="panel__title">
            原始触发记录<span class="panel__title-tag">分批加载，每次 {{ 100 }} 条</span>
          </h2>
          <NButton size="tiny" quaternary :loading="rawLoading" @click="resetRaw">
            {{ rawEntries.length === 0 ? '加载首批' : '重新加载' }}
          </NButton>
        </div>
        <div v-if="rawEntries.length > 0" class="raw-list">
          <div v-for="entry in rawEntries" :key="entry.id" class="raw-row">
            <span class="mono raw-seq">L{{ entry.lineNo }}</span>
            <span class="mono raw-time">{{ entry.rawTimestamp || '—' }}</span>
            <NTag size="tiny" :type="kindTag(entry.triggerKind).type" :bordered="false">
              {{ kindTag(entry.triggerKind).text }}
            </NTag>
            <span class="mono raw-no">{{ entry.cueNo || '—' }}</span>
            <span class="raw-msg" :title="entry.raw">{{ entry.message || entry.raw }}</span>
            <NTag v-if="entry.dupTimestamp" size="tiny" type="warning" :bordered="false">重复时间戳</NTag>
          </div>
        </div>
        <div v-if="rawPage >= 0 && rawEntries.length > 0" class="raw-more">
          <NButton size="small" :loading="rawLoading" @click="loadRawPage">加载下一批</NButton>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.subtitle-inline {
  font-size: 13px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.45);
  margin-left: 10px;
}

.recon-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.recon-toolbar__info {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.stat-chip {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.stat-chip b {
  color: #f2b544;
  font-size: 14px;
}

.stat-chip.warn b {
  color: #e8b45a;
}

.recon-progress {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 14px;
}

.progress-label {
  font-size: 12px;
  white-space: nowrap;
}

.recon-note {
  margin: 10px 0 0;
  font-size: 12px;
}

.pair-table {
  display: flex;
  flex-direction: column;
}

.pair-row {
  display: grid;
  grid-template-columns: 86px 76px minmax(140px, 1.6fr) auto 90px 96px 78px 64px;
  gap: 10px;
  align-items: center;
  padding: 7px 8px;
  border-radius: 8px;
}

.pair-row:not(.pair-row--head):hover {
  background: rgba(255, 255, 255, 0.03);
}

.pair-row--head {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.col-label,
.item-label,
.candidate-msg,
.raw-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.col-kind {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.col__head {
  margin: 0 0 8px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}

.cue-item,
.log-item {
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  margin-bottom: 6px;
  background: rgba(255, 255, 255, 0.02);
}

.cue-item--open,
.log-item--open {
  border-color: rgba(242, 181, 68, 0.4);
}

.item-main {
  width: 100%;
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr) auto 60px 72px;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.log-item .item-main {
  grid-template-columns: 86px 56px minmax(0, 1fr) 86px 72px;
}

.item-no {
  color: #f2b544;
  font-weight: 600;
}

.item-plan,
.item-cand {
  font-size: 11px;
  text-align: right;
}

.candidate-box {
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.candidate-row {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.candidate-row__main,
.candidate-row__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.candidate-no {
  color: #f2b544;
}

.raw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.raw-head .panel__title {
  margin-bottom: 0;
}

.raw-list {
  margin-top: 10px;
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.raw-row {
  display: grid;
  grid-template-columns: 56px 96px 52px 76px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 5px 8px;
  font-size: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.raw-time {
  color: rgba(255, 255, 255, 0.55);
}

.raw-no {
  color: #f2b544;
}

.raw-more {
  margin-top: 10px;
  text-align: center;
}

@media (max-width: 980px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
