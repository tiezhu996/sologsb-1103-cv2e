<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NDatePicker,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
  NUpload,
  useMessage,
  type UploadFileInfo
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { useSessionStore } from '@/stores/sessionStore'
import { useReconStore } from '@/stores/reconStore'
import type { LogImport } from '@/types/recon'
import { formatDateTime } from '@/utils/fade'
import { todayLogDate } from '@/utils/logParse'
import ReconReportView from '@/components/recon/ReconReportView.vue'

const message = useMessage()
const sessionStore = useSessionStore()
const reconStore = useReconStore()

const selectedSessionId = computed(() => sessionStore.currentSessionId ?? '')
const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

const logDate = ref(todayLogDate())
const gapThresholdSec = ref(120)
const note = ref('')
const pendingFile = ref<File | null>(null)
const pendingName = ref('')
const busy = ref(false)
const openReportId = ref<string | null>(null)
const showAllSessions = ref(false)
/** 续传时记录「给哪个导入任务选文件」 */
const resumeImportId = ref<string | null>(null)

const imports = computed(() =>
  showAllSessions.value
    ? [...reconStore.imports].sort((a, b) => b.updatedAt - a.updatedAt)
    : reconStore.importsOfSession(selectedSessionId.value)
)
const reports = computed(() =>
  showAllSessions.value ? reconStore.reportsSorted : reconStore.reportsOfSession(selectedSessionId.value)
)
const openReport = computed(() => (openReportId.value ? reconStore.reportById(openReportId.value) : null))

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function progressPercent(item: LogImport): number {
  if (item.fileSize === 0) return 0
  return Math.min(100, Math.round((item.offset / item.fileSize) * 100))
}

function statusMeta(item: LogImport): { text: string; type: 'success' | 'warning' | 'error' | 'info' } {
  switch (item.status) {
    case 'done':
      return { text: '已完成', type: 'success' }
    case 'parsing':
      return { text: '解析中', type: 'info' }
    case 'failed':
      return { text: '中断', type: 'error' }
    case 'paused':
      return { text: item.offset > 0 ? '已暂停（可续传）' : '待开始', type: 'warning' }
  }
}

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string') sessionStore.setCurrentSession(value)
}

/** 新导入选文件（default-upload=false，文件只留在本地） */
function handleNewFile(data: { file?: UploadFileInfo; fileList: UploadFileInfo[] }): void {
  const file = data.file?.file ?? data.fileList[data.fileList.length - 1]?.file
  if (file) {
    pendingFile.value = file
    pendingName.value = file.name
  }
}

/** 续传选文件：先在卡片按钮上记下 importId，change 触发后开始续传 */
function handleResumeFile(data: { file?: UploadFileInfo; fileList: UploadFileInfo[] }): void {
  const importId = resumeImportId.value
  resumeImportId.value = null
  const file = data.file?.file ?? data.fileList[data.fileList.length - 1]?.file
  if (file && importId) void doResume(importId, file)
}

async function startImport(): Promise<void> {
  if (!selectedSessionId.value) {
    message.warning('请先选择场次')
    return
  }
  if (!pendingFile.value) {
    message.warning('请先选择控台日志文件（.log / .txt / .csv）')
    return
  }
  busy.value = true
  try {
    const record = await reconStore.createImport({
      sessionId: selectedSessionId.value,
      fileName: pendingFile.value.name,
      fileSize: pendingFile.value.size,
      logDate: logDate.value
    })
    const result = await reconStore.runImport(record.id, pendingFile.value)
    if (result.done) {
      message.success(`日志导入完成，共解析 ${record.lineCount} 行`)
    } else if (!result.ok) {
      message.error(result.message ?? '导入失败，已保留进度')
    }
    pendingFile.value = null
    pendingName.value = ''
  } finally {
    busy.value = false
  }
}

async function doResume(importId: string, file: File): Promise<void> {
  busy.value = true
  try {
    const result = await reconStore.runImport(importId, file)
    if (result.done) message.success('续传完成，日志已全部导入')
    else if (!result.ok) message.error(result.message ?? '续传失败，进度仍保留')
    else message.info('已暂停，进度已保留')
  } finally {
    busy.value = false
  }
}

function clickResume(item: LogImport): void {
  resumeImportId.value = item.id
}

function pauseImport(): void {
  reconStore.pauseRunning()
  message.info('将在当前文件块读完后暂停，进度会保留')
}

async function confirmRemoveImport(item: LogImport): Promise<void> {
  await reconStore.removeImport(item.id)
  message.success('已删除导入任务及其日志与报告')
}

async function confirmRemoveReport(reportId: string): Promise<void> {
  await reconStore.removeReport(reportId)
  if (openReportId.value === reportId) openReportId.value = null
  message.success('对账报告已删除')
}

async function generate(item: LogImport): Promise<void> {
  busy.value = true
  try {
    const result = await reconStore.generateReport({
      importId: item.id,
      gapThresholdSec: gapThresholdSec.value,
      note: note.value
    })
    if ('error' in result) {
      message.error(result.error)
      return
    }
    message.success(`已生成 ${result.reportNo}，对上 ${result.stats.matched} 条，候选 ${result.stats.candidates} 条`)
    note.value = ''
    openReportId.value = result.id
  } finally {
    busy.value = false
  }
}

function sessionTitleOf(sessionId: string): string {
  const session = sessionStore.sessionById(sessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">控台日志对账</h1>
        <p class="page__subtitle">
          演出结束后把灯控台日志按 Cue 编号、提示语与触发顺序对回 Cue 表：配不准的先留候选，
          导入中断可从断点续传；历史排演表的生成时快照不受影响。
        </p>
      </div>
    </header>

    <NAlert v-if="sessionStore.sortedSessions.length === 0" type="info" :bordered="false">
      还没有场次。请先在场次编排中创建场次并插入 Cue，再来导入日志对账。
    </NAlert>

    <template v-else>
      <!-- ① 导入日志 -->
      <section class="panel">
        <h2 class="panel__title">
          导入控台日志
          <span class="panel__title-tag">分批解析落库，中断保留进度</span>
        </h2>

        <div class="import-toolbar">
          <NSelect
            :value="selectedSessionId || null"
            :options="sessionOptions"
            placeholder="选择场次"
            style="width: 260px"
            @update:value="handleSessionChange"
          />
          <div class="import-field">
            <span class="import-field__label">演出日期</span>
            <NDatePicker v-model:formatted-value="logDate" value-format="yyyy-MM-dd" type="date" style="width: 150px" />
          </div>
          <div class="import-field">
            <span class="import-field__label">缺段阈值</span>
            <NInputNumber v-model:value="gapThresholdSec" :min="10" :max="3600" :step="10" style="width: 120px">
              <template #suffix>秒</template>
            </NInputNumber>
          </div>
        </div>

        <div class="import-new">
          <NUpload
            :default-upload="false"
            accept=".log,.txt,.csv"
            :max="1"
            :show-file-list="false"
            @change="handleNewFile"
          >
            <NButton>选择日志文件</NButton>
          </NUpload>
          <span v-if="pendingName" class="import-new__file mono">{{ pendingName }}</span>
          <span v-else class="muted">支持行首 `HH:mm:ss` / 完整日期时间，正文识别 Q12、Cue 12、GO / 手动补点等</span>
          <span class="toolbar__spacer" />
          <NButton type="primary" :loading="busy" :disabled="!pendingName" @click="startImport">开始导入</NButton>
          <NButton v-if="reconStore.progress" quaternary @click="pauseImport">暂停（保留断点）</NButton>
        </div>

        <div v-if="reconStore.progress" class="import-running">
          <div class="import-running__bar">
            <div
              class="import-running__fill"
              :style="{ width: `${Math.min(100, (reconStore.progress.doneBytes / Math.max(1, reconStore.progress.totalBytes)) * 100)}%` }"
            />
          </div>
          <p class="import-running__text mono">
            {{ reconStore.progress.phase === 'flushing' ? '正在分批落库…' : '正在分批读取解析…' }}
            {{ Math.round((reconStore.progress.doneBytes / Math.max(1, reconStore.progress.totalBytes)) * 100) }}%
            · 已识别 {{ reconStore.progress.lineCount }} 行
          </p>
        </div>

        <!-- 历史导入任务 -->
        <div class="import-history-head">
          <h3 class="import-history-title">导入任务<span class="panel__title-tag">共 {{ imports.length }} 个</span></h3>
          <span class="import-history-head__switch">
            <span class="muted">显示全部场次</span>
            <NSelect
              :value="showAllSessions ? 'all' : 'current'"
              size="tiny"
              style="width: 96px"
              :options="[
                { label: '仅本场', value: 'current' },
                { label: '全部', value: 'all' }
              ]"
              @update:value="(value) => (showAllSessions = value === 'all')"
            />
          </span>
        </div>

        <BlankHint
          v-if="imports.length === 0"
          title="还没有导入过控台日志"
          description="选择演出导出的 .log/.txt 文件后点「开始导入」，解析按批次让出页面，长日志也不会卡住。"
        />

        <div v-else class="import-list">
          <article v-for="item in imports" :key="item.id" class="import-card">
            <div class="import-card__head">
              <span class="import-card__name mono">{{ item.fileName }}</span>
              <NTag size="small" :type="statusMeta(item).type" :bordered="false">{{ statusMeta(item).text }}</NTag>
              <span class="muted import-card__session">{{ sessionTitleOf(item.sessionId) }}</span>
              <span class="toolbar__spacer" />
              <span class="muted mono">{{ formatBytes(item.fileSize) }} · {{ item.lineCount }} 行</span>
              <span class="muted mono">{{ formatDateTime(item.updatedAt) }}</span>
            </div>

            <div v-if="item.status !== 'done'" class="import-card__progress">
              <div class="import-card__bar">
                <div class="import-card__fill" :style="{ width: `${progressPercent(item)}%` }" />
              </div>
              <span class="muted mono">{{ progressPercent(item) }}%</span>
            </div>

            <p v-if="item.lastError" class="import-card__error">{{ item.lastError }}</p>

            <div class="import-card__actions">
              <template v-if="item.status === 'done'">
                <NButton size="small" type="primary" :loading="busy" @click="generate(item)">对账并生成报告</NButton>
              </template>
              <template v-else>
                <NUpload
                  :default-upload="false"
                  accept=".log,.txt,.csv"
                  :max="1"
                  :show-file-list="false"
                  :disabled="busy"
                  @click="clickResume(item)"
                  @change="handleResumeFile"
                >
                  <NButton size="small" type="primary" :loading="busy">
                    {{ item.offset > 0 ? '选同一文件从断点续传' : '选文件开始' }}
                  </NButton>
                </NUpload>
                <span class="muted import-card__hint">从 {{ formatBytes(item.offset) }} 处继续，已解析行会保留</span>
              </template>
              <span class="toolbar__spacer" />
              <NButton size="small" quaternary type="error" @click="confirmRemoveImport(item)">删除</NButton>
            </div>
          </article>
        </div>

        <div class="import-note">
          <NInput v-model:value="note" placeholder="对账备注，例如「首演晚场」（可选）" style="max-width: 320px" />
        </div>
      </section>

      <!-- ② 报告 -->
      <section class="panel">
        <h2 class="panel__title">对账报告<span class="panel__title-tag">保存生成时刻结果，共 {{ reports.length }} 份</span></h2>

        <BlankHint
          v-if="reports.length === 0"
          title="还没有对账报告"
          description="导入完成后在上方任务卡片点「对账并生成报告」。配不准的条目会进候选，可在报告里人工确认。"
          tip="报告与历史排演表一样按生成时快照留档，之后修改 Cue 不影响已有报告。"
        />

        <div v-else class="report-list">
          <article v-for="report in reports" :key="report.id" class="report-card">
            <div class="report-card__head">
              <span class="report-card__no mono">{{ report.reportNo }}</span>
              <span class="report-card__session">{{ report.sessionTitle }}</span>
              <span class="toolbar__spacer" />
              <span class="muted mono">{{ formatDateTime(report.generatedAt) }}</span>
            </div>
            <div class="report-card__stats">
              <span>Cue {{ report.stats.cueTotal }}</span>
              <span class="ok">对上 {{ report.stats.matched }}</span>
              <span class="warn">候选 {{ report.stats.candidates }}</span>
              <span class="bad">未对上 Cue {{ report.stats.unmatchedCues }}</span>
              <span>未对上日志 {{ report.stats.unmatchedLogs }}</span>
              <span>缺段 {{ report.stats.gaps }}</span>
            </div>
            <div class="report-card__actions">
              <NButton size="small" type="primary" @click="openReportId = report.id">查看 / 人工配对</NButton>
              <NButton size="small" quaternary type="error" @click="confirmRemoveReport(report.id)">删除</NButton>
            </div>
          </article>
        </div>
      </section>

      <!-- 报告查看抽屉式内嵌 -->
      <ReconReportView v-if="openReport" :report="openReport" @close="openReportId = null" />
    </template>
  </div>
</template>

<style scoped>
.import-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.import-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.55);
}

.import-field__label {
  white-space: nowrap;
}

.import-new {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.import-new__file {
  font-size: 13px;
  color: #f2b544;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-running {
  margin-top: 14px;
}

.import-running__bar,
.import-card__bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.import-running__fill,
.import-card__fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #d99b2c, #f2b544);
  transition: width 0.2s ease;
}

.import-running__text {
  margin: 8px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.import-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 20px 0 10px;
}

.import-history-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.75);
  display: flex;
  align-items: center;
  gap: 8px;
}

.import-history-head__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.import-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-card {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.import-card__name {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.88);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-card__session {
  font-size: 12px;
}

.import-card__progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.import-card__bar {
  flex: 1;
}

.import-card__error {
  margin: 0;
  font-size: 12px;
  color: #e8826d;
}

.import-card__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.import-card__hint {
  font-size: 12px;
}

.import-note {
  margin-top: 12px;
}

.report-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
}

.report-card {
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.report-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.report-card__no {
  font-weight: 600;
  color: #f2b544;
}

.report-card__session {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}

.report-card__stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.report-card__stats .ok {
  color: #3fbf9f;
}

.report-card__stats .warn {
  color: #f2b544;
}

.report-card__stats .bad {
  color: #e8826d;
}

.report-card__actions {
  display: flex;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
</style>
