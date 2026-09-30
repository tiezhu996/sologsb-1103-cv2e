<script setup lang="ts" generic="T">
/**
 * 异步定高虚拟列表：只渲染可视区行；数据由 loader(startSeq, limit) 按窗口从
 * IndexedDB 分段取，长日志不会一次性入内存、不卡页面。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 总行数 */
    total: number
    /** 行高（px），必须与渲染行高度一致 */
    rowHeight?: number
    /** 可视区外多渲染的行数 */
    overscan?: number
    /** 按起始行号（1 基）取一屏数据，返回长度最多 limit 的数组（按行号升序） */
    loader: (startSeq: number, limit: number) => Promise<T[]>
    /** 外部数据变化（如换报告 / 改配）时强制重载 */
    reloadKey?: string | number
    /** 空数据文案 */
    emptyText?: string
  }>(),
  {
    rowHeight: 34,
    overscan: 14,
    reloadKey: ''
  }
)

const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(420)
let observer: ResizeObserver | null = null
let raf = 0
let loadToken = 0

const totalHeight = computed(() => props.total * props.rowHeight)

const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - Math.floor(props.overscan / 2))
  const count = Math.ceil(viewportHeight.value / props.rowHeight) + props.overscan
  const end = Math.min(props.total, start + count)
  return { start, end }
})

/** 当前窗口：loadedStart（1 基）+ items（不足一屏时尾部自然留空） */
const loadedStart = ref(1)
// shallowRef：泛型 T 下避免 Vue 深层解包把类型推成 UnwrapRefSimple<T>
const items = shallowRef<T[]>([])
const loading = ref(false)

async function loadWindow(): Promise<void> {
  if (props.total === 0) {
    items.value = []
    return
  }
  const startSeq = visibleRange.value.start + 1
  const limit = visibleRange.value.end - visibleRange.value.start + props.overscan
  const token = ++loadToken
  loading.value = true
  try {
    const data = await props.loader(startSeq, limit)
    if (token !== loadToken) return
    loadedStart.value = startSeq
    items.value = data
  } finally {
    if (token === loadToken) loading.value = false
  }
}

watch(
  () => [visibleRange.value.start, visibleRange.value.end, props.total, props.reloadKey],
  () => {
    void loadWindow()
  },
  { immediate: true }
)

function onScroll(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    if (scrollEl.value) scrollTop.value = scrollEl.value.scrollTop
  })
}

function setScroller(el: Element | null): void {
  observer?.disconnect()
  scrollEl.value = el as HTMLElement | null
  if (!el) return
  viewportHeight.value = el.clientHeight || viewportHeight.value
  observer = new ResizeObserver(() => {
    if (scrollEl.value) viewportHeight.value = scrollEl.value.clientHeight
  })
  observer.observe(el)
}

onBeforeUnmount(() => {
  observer?.disconnect()
  if (raf) cancelAnimationFrame(raf)
})

/** 取第 index（0 基）行数据，窗口未覆盖返回 null */
function itemAt(index: number): T | null {
  const itemIndex = index - (loadedStart.value - 1)
  if (itemIndex < 0 || itemIndex >= items.value.length) return null
  return items.value[itemIndex]
}
</script>

<template>
  <div v-if="total === 0" class="virtual-list--empty">{{ emptyText || '暂无数据' }}</div>
  <div v-else ref="setScroller" class="virtual-list" @scroll.passive="onScroll">
    <div class="virtual-list__phantom" :style="{ height: `${totalHeight}px` }">
      <div class="virtual-list__view" :style="{ transform: `translateY(${visibleRange.start * rowHeight}px)` }">
        <div
          v-for="offset in visibleRange.end - visibleRange.start"
          :key="visibleRange.start + offset - 1"
          class="virtual-list__row"
          :style="{ height: `${rowHeight}px` }"
        >
          <slot :item="itemAt(visibleRange.start + offset - 1)" :index="visibleRange.start + offset - 1" />
        </div>
      </div>
    </div>
    <div v-if="loading" class="virtual-list__hint">加载中…</div>
  </div>
</template>

<style scoped>
.virtual-list {
  position: relative;
  height: 420px;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(11, 13, 18, 0.6);
}

.virtual-list--empty {
  padding: 26px;
  text-align: center;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.35);
  border-radius: 10px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
}

.virtual-list__phantom {
  position: relative;
  width: 100%;
}

.virtual-list__view {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.virtual-list__row {
  display: flex;
  align-items: stretch;
}

.virtual-list__hint {
  position: sticky;
  bottom: 8px;
  margin-left: 50%;
  transform: translateX(-50%);
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  background: rgba(20, 24, 34, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  pointer-events: none;
}
</style>
