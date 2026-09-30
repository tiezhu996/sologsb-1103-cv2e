<script setup lang="ts">
import { NButton, NTag } from 'naive-ui'
import type { ReconPair } from '@/types/recon'
import { formatSignedSeconds } from '@/utils/export'
import { formatClock } from '@/utils/reconcile'

defineProps<{
  pair: ReconPair
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: [cueId: string, entryId: string]
  unresolve: [cueId: string]
}>()

function deviationType(sec: number | null): 'success' | 'warning' | 'error' | 'default' {
  if (sec === null) return 'default'
  const abs = Math.abs(sec)
  if (abs <= 3) return 'success'
  if (abs <= 15) return 'warning'
  return 'error'
}
</script>

<template>
  <div class="pair-inner">
    <div class="pair-inner__line">
      <span class="pair-inner__no mono">{{ pair.cueNo }}</span>
      <span class="pair-inner__label">{{ pair.label || '（无提示语）' }}</span>
      <NTag size="tiny" :type="pair.status === 'candidate' ? 'warning' : 'success'" :bordered="false">
        {{ pair.status === 'candidate' ? '候选' : '对上' }}
      </NTag>
      <span class="pair-inner__spacer" />
      <span class="pair-inner__time mono">计划 {{ formatClock(pair.plannedTime) }}</span>
      <span class="pair-inner__time mono">实际 {{ formatClock(pair.actualTime) }}</span>
      <NTag size="small" :type="deviationType(pair.deviationSec)" :bordered="false">
        偏差 {{ formatSignedSeconds(pair.deviationSec) }}
      </NTag>
    </div>

    <div class="pair-inner__reason muted">{{ pair.matchReason }}</div>

    <div v-if="pair.candidates.length > 0" class="pair-inner__candidates">
      <div v-for="candidate in pair.candidates" :key="candidate.entryId" class="pair-candidate">
        <NButton
          size="tiny"
          type="primary"
          :loading="busy"
          @click="emit('confirm', pair.cueId, candidate.entryId)"
        >
          确认
        </NButton>
        <NTag size="tiny" :type="candidate.score >= 60 ? 'warning' : 'default'" :bordered="false">
          {{ candidate.score }} 分
        </NTag>
        <span class="mono pair-candidate__time">{{ candidate.time !== null ? formatClock(candidate.time) : '无时间' }}</span>
        <span v-if="candidate.cueNo" class="mono pair-candidate__no">{{ candidate.cueNo }}</span>
        <span class="pair-candidate__text">{{ candidate.text }}</span>
        <span class="muted pair-candidate__reason">{{ candidate.reason }}</span>
      </div>
    </div>

    <div class="pair-inner__actions">
      <NButton size="tiny" quaternary :loading="busy" @click="emit('unresolve', pair.cueId)">取消配对</NButton>
    </div>
  </div>
</template>

<style scoped>
.pair-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.pair-inner__line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pair-inner__no {
  color: #f2b544;
  font-weight: 600;
  min-width: 56px;
}

.pair-inner__label {
  font-size: 13px;
}

.pair-inner__spacer {
  flex: 1;
}

.pair-inner__time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.pair-inner__reason {
  font-size: 11px;
}

.pair-inner__candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pair-candidate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(242, 181, 68, 0.06);
  border: 1px solid rgba(242, 181, 68, 0.18);
  font-size: 12px;
}

.pair-candidate__time {
  color: rgba(255, 255, 255, 0.6);
}

.pair-candidate__no {
  color: #f2b544;
}

.pair-candidate__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pair-candidate__reason {
  font-size: 11px;
}

.pair-inner__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
