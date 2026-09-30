<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import type { ResolutionEntry } from '@/stores/reconStore'
import { formatClock } from '@/utils/reconcile'

const props = defineProps<{
  cueId: string
  cueNo: string
  label: string
  planned: number | null
  options: Array<{ label: string; value: string; entry: ResolutionEntry }>
  busy: boolean
}>()

const emit = defineEmits<{ pair: [cueId: string, entry: ResolutionEntry] }>()

const selected = ref<string | null>(null)

function confirm(): void {
  const option = props.options.find((item) => item.value === selected.value)
  if (!option) return
  emit('pair', props.cueId, option.entry)
  selected.value = null
}
</script>

<template>
  <div class="unmatched-inner">
    <div class="unmatched-inner__line">
      <span class="unmatched-inner__no mono">{{ cueNo }}</span>
      <span class="unmatched-inner__label">{{ label || '（无提示语）' }}</span>
      <span class="unmatched-inner__spacer" />
      <span class="muted mono">计划 {{ formatClock(planned) }}</span>
    </div>
    <div class="unmatched-inner__pick">
      <NSelect
        v-model:value="selected"
        :options="options"
        filterable
        size="small"
        placeholder="从未对上 / 已配在别处的日志中选择一条"
        style="flex: 1; min-width: 260px"
      />
      <NButton size="small" type="primary" :disabled="!selected" :loading="busy" @click="confirm">人工配对</NButton>
    </div>
  </div>
</template>

<style scoped>
.unmatched-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.unmatched-inner__line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.unmatched-inner__no {
  color: #e8826d;
  font-weight: 600;
  min-width: 56px;
}

.unmatched-inner__label {
  font-size: 13px;
}

.unmatched-inner__spacer {
  flex: 1;
}

.unmatched-inner__pick {
  display: flex;
  gap: 8px;
}
</style>
