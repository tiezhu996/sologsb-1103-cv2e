<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NProgress, NSelect, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { useLogStore } from '@/stores/logStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { ConsoleLog, LogProgress } from '@/types/log'
import { formatDateTime } from '@/utils/fade'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const logStore = useLogStore()
const sessionStore = useSessionStore()

const showAllSessions = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const pendingFile = ref<File | null>(null)
const busy = ref(false)

const selectedSessionId = computed(() => sessionStore.currentSessionId ?? '')

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

const logs = computed(() =>
  showAllSessions.value ? logStore.logsSorted : logStore.logsOfSession(selectedSessionId.value)
)

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string') sessionStore.setCurrentSession(value)
}

function handleShowAll(value: string | number | boolean): void {
  showAllSessions.value = value === true
}

function pickFile(): void {
  if (!selectedSessionId.value) {
    message.warning('请先选择场次')
    return
  }
  fileInput.value?.click()
}

function onFileChosen(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 200 * 1024 * 1024) {
    message.warning('日志文件过大（>200MB），请先在控台软件中截取本场记录')
    return
  }
  pendingFile.value = file
  void startImport(file)
}

async function startImport(file: File): Promise<void> {
  if (!selectedSessionId.value || busy.value) return
  busy.value = true
  try {
    const result = await logStore.startImport(selectedSessionId.value, file, () => {
      // 进度通过 logStore.running 响应式读取，这里仅驱动渲染
    })
    if (result.resumed) message.success(`已从断点继续导入 ${result.log.fileName}`)
    else message.success(`导入完成：识别触发记录 ${result.log.entryCount} 条`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '导入失败，进度已保留，可从断点重试')
  } finally {
    pendingFile.value = null
    busy.value = false
  }
}

async function retry(log: ConsoleLog): Promise<void> {
  busy.value = true
  try {
    // 优先尝试内存中的文件句柄（同一次打开页面内失败）
    await logStore.resumeImport(log.id)
    message.success('断点续传完成')
  } catch (error) {
    message.info(error instanceof Error ? error.message : '请重新选择原始日志文件')
    pendingFile.value = null
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.log,.txt,text/plain,text/csv'
    input.onchange = async (): Promise<void> => {
      const file = input.files?.[0]
      if (!file) {
        busy.value = false
        return
      }
      if (file.name !== log.fileName || file.size !== log.fileSize) {
        message.warning('选择的文件名或大小与原记录不一致，请确认是否为同一份日志')
      }
      try {
        await logStore.resumeImport(log.id, file)
        message.success('断点续传完成')
      } catch (retryError) {
        message.error(retryError instanceof Error ? retryError.message : '续传失败')
      } finally {
        busy.value = false
      }
    }
    input.click()
    busy.value = false
    return
  }
  busy.value = false
}

function progressOf(log: ConsoleLog): LogProgress | null {
  return logStore.running[log.id] ?? null
}

function statusTag(log: ConsoleLog): { type: 'success' | 'warning' | 'error'; text: string } {
  if (log.status === 'done') return { type: 'success', text: '已完成' }
  if (log.status === 'failed') return { type: 'error', text: '中断·可续传' }
  return { type: 'warning', text: '导入中' }
}

function sessionTitle(log: ConsoleLog): string {
  const session = sessionStore.sessionById(log.sessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function openDetail(log: ConsoleLog): void {
  void router.push(`/reconcile/${log.id}`)
}

function confirmRemove(log: ConsoleLog): void {
  dialog.warning({
    title: '删除日志',
    content: `将删除「${log.fileName}」及其全部触发条目与对账报告，操作不可恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await logStore.removeLog(log.id)
      message.success('日志已删除')
    }
  })
}

function goCues(): void {
  if (!selectedSessionId.value) {
    void router.push('/sessions')
    return
  }
  void router.push(`/sessions/${selectedSessionId.value}/cues`)
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">灯控日志对账</h1>
        <p class="page__subtitle">
          导入控台日志后按 Cue 编号、提示语与触发顺序和排好的 Cue 表配对；把握不足的先保留候选，可人工裁决。
          导入分批进行、中断可从断点续传。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goCues">Cue 时间轴</NButton>
      </div>
    </header>

    <NAlert v-if="sessionStore.sortedSessions.length === 0" type="info" :bordered="false">
      还没有场次。请先在场次编排中创建场次并插入 Cue，再来导入日志对账。
    </NAlert>

    <template v-else>
      <section class="panel">
        <h2 class="panel__title">导入灯控台日志<span class="panel__title-tag">支持 .log / .txt，逐批解析入库</span></h2>
        <div class="import-bar">
          <NSelect
            :value="selectedSessionId || null"
            :options="sessionOptions"
            placeholder="选择场次"
            style="width: 260px"
            @update:value="handleSessionChange"
          />
          <input
            ref="fileInput"
            type="file"
            accept=".log,.txt,text/plain,text/csv"
            hidden
            @change="onFileChosen"
          />
          <NButton type="primary" :loading="busy" :disabled="!selectedSessionId" @click="pickFile">
            选择日志文件并导入
          </NButton>
          <span class="muted import-hint">
            演员抢台词、灯控手动补点后，仅按计划时刻难以定位；导入后会综合编号、提示语与触发顺序匹配。
          </span>
        </div>
      </section>

      <section class="panel">
        <div class="sheet-history-head">
          <h2 class="panel__title">日志记录<span class="panel__title-tag">共 {{ logs.length }} 份</span></h2>
          <span class="switch-line">
            <span class="muted">显示全部场次</span>
            <NSwitch :value="showAllSessions" size="small" @update:value="(value) => handleShowAll(value)" />
          </span>
        </div>

        <BlankHint
          v-if="logs.length === 0"
          title="还没有导入过灯控台日志"
          description="演出结束后导出控台日志（含 GO / 手动补点时间戳），选择对应场次后导入。"
          tip="导入进度会持续保存在浏览器本地；缺段、重复时间戳或中途失败都可以从断点继续。"
        />

        <div v-else class="log-list">
          <article v-for="log in logs" :key="log.id" class="log-card">
            <div class="log-card__head">
              <span class="log-card__name">{{ log.fileName }}</span>
              <NTag size="small" :type="statusTag(log).type" :bordered="false">{{ statusTag(log).text }}</NTag>
              <span class="toolbar__spacer" />
              <span class="muted mono">{{ formatSize(log.fileSize) }}</span>
            </div>

            <div class="log-card__session">{{ sessionTitle(log) }} · 导入于 {{ formatDateTime(log.importedAt) }}</div>

            <div v-if="log.status !== 'done' || progressOf(log)" class="log-card__progress">
              <NProgress
                type="line"
                :percentage="Math.round((progressOf(log)?.ratio ?? log.bytesOffset / Math.max(1, log.bytesTotal)) * 100)"
                :height="6"
                :show-indicator="false"
                processing
              />
              <span class="mono muted progress-text">
                {{ Math.round((progressOf(log)?.ratio ?? log.bytesOffset / Math.max(1, log.bytesTotal)) * 100) }}%
                <template v-if="progressOf(log)">
                  （{{ progressOf(log)?.phase === 'read' ? '读取解析' : '处理' }}中…）
                </template>
              </span>
            </div>

            <div v-if="log.status === 'failed' && log.error" class="log-card__error">
              上次中断：{{ log.error }}。已处理 {{ log.entryCount }} 条触发记录，进度保留至
              {{ Math.round((log.bytesOffset / Math.max(1, log.bytesTotal)) * 100) }}%。
            </div>

            <div v-if="log.status === 'done'" class="log-card__stats">
              <span>触发记录 <b class="accent">{{ log.entryCount }}</b> 条</span>
              <span>系统信息 {{ log.infoCount }} 行</span>
              <span v-if="log.malformedCount > 0" class="warn-text">未识别 {{ log.malformedCount }} 行</span>
            </div>

            <ul v-if="log.warnings.length > 0" class="log-card__warnings">
              <li v-for="warning in log.warnings" :key="warning" class="warn-text">{{ warning }}</li>
            </ul>

            <div class="log-card__actions">
              <NButton size="tiny" type="primary" :disabled="log.entryCount === 0" @click="openDetail(log)">
                进入对账
              </NButton>
              <NButton v-if="log.status !== 'done'" size="tiny" :loading="busy" @click="retry(log)">
                从断点继续
              </NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(log)">删除</NButton>
            </div>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.import-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.import-hint {
  font-size: 12px;
  max-width: 520px;
  line-height: 1.6;
}

.sheet-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.switch-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.log-card {
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.log-card__name {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.log-card__session {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.log-card__progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-text {
  font-size: 12px;
  min-width: 110px;
  text-align: right;
}

.log-card__error {
  font-size: 12px;
  color: #ff8a8a;
  line-height: 1.6;
}

.log-card__stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.warn-text {
  color: #e8b45a;
}

.log-card__warnings {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}

.log-card__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
</style>
