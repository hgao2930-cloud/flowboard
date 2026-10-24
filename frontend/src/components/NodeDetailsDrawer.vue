<script setup lang="ts">
import { reactive, watch, nextTick } from 'vue'
import { nodeColors } from '@/collaboration/document'
import type { SharedNode, NodeDataPatch, RoomMember, NodeColor } from '@/collaboration/session'
import BoardIcon from './BoardIcon.vue'

const props = defineProps<{
  node: SharedNode
  editors: RoomMember[]
  update: (id: string, patch: NodeDataPatch) => boolean
}>()
const emit = defineEmits<{ close: []; delete: []; duplicate: []; 'end-edit': [] }>()
const nodeId = props.node.id
type TextField = 'label' | 'content'
const fields = reactive({
  label: { value: props.node.data.label, focused: false, composing: false, remoteChanged: false },
  content: {
    value: props.node.data.content,
    focused: false,
    composing: false,
    remoteChanged: false,
  },
})
const colorNames = { mint: '薄荷', blue: '天空', violet: '鸢尾', amber: '麦穗', rose: '玫瑰' }

for (const key of ['label', 'content'] as const) {
  watch(
    () => props.node.data[key],
    (value) => {
      const field = fields[key]
      if (field.value === value) {
        field.remoteChanged = false
        return
      }
      // 当前聚焦字段保留输入与光标；其他字段立即跟随共享值。
      if (field.focused || field.composing) field.remoteChanged = true
      else {
        field.value = value
        field.remoteChanged = false
      }
    },
  )
}
function publish(key: TextField) {
  const field = fields[key]
  if (!field.composing && props.update(nodeId, { [key]: field.value })) field.remoteChanged = false
}
function input(key: TextField, event: Event) {
  fields[key].value = (event.target as HTMLInputElement | HTMLTextAreaElement).value
  publish(key)
}
function compositionEnd(key: TextField, event: CompositionEvent) {
  fields[key].composing = false
  input(key, event)
}
async function blur(key: TextField) {
  if (fields[key].composing) {
    fields[key].composing = false
    publish(key)
  }
  fields[key].focused = false
  emit('end-edit')
  await nextTick()
  fields[key].value = props.node.data[key]
  fields[key].remoteChanged = false
}
function titleKeydown(event: KeyboardEvent) {
  if (
    event.key === 'Enter' &&
    !event.isComposing &&
    !fields.label.composing &&
    event.keyCode !== 229
  ) {
    event.preventDefault()
    ;(event.target as HTMLInputElement).blur()
  }
}
function finishComposition() {
  for (const key of ['label', 'content'] as const) {
    if (fields[key].composing) {
      fields[key].composing = false
      publish(key)
    }
  }
  emit('end-edit')
}
function selectColor(color: NodeColor) {
  props.update(nodeId, { color })
  emit('end-edit')
}
function duplicate() {
  finishComposition()
  emit('duplicate')
}
defineExpose({ finishComposition })
</script>

<template>
  <aside class="details-panel" aria-label="卡片详情" @keydown.stop @keyup.stop>
    <div class="panel-heading">
      <div>
        <span class="eyebrow">INSPECTOR</span>
        <h2>卡片详情</h2>
      </div>
      <button class="icon-button" title="关闭详情" aria-label="关闭详情" @click="emit('close')">
        <BoardIcon name="close" />
      </button>
    </div>
    <div class="details-status">
      <span class="live-dot"></span> 输入即同步 <span class="muted">· 无需保存</span>
    </div>
    <div v-if="editors.length" class="coediting-note">
      <span class="tiny-avatar" :style="{ background: editors[0]?.color }">{{
        editors[0]?.name.slice(0, 1)
      }}</span>
      {{ editors.map((member) => member.name).join('、') }} 也在编辑
    </div>
    <div class="field-group">
      <label for="node-title"
        >标题 <span>{{ fields.label.value.length }}/160</span></label
      >
      <input
        id="node-title"
        :value="fields.label.value"
        maxlength="160"
        placeholder="给这张卡片起个名字"
        autocomplete="off"
        @input="input('label', $event)"
        @focus="fields.label.focused = true"
        @blur="blur('label')"
        @keydown="titleKeydown"
        @compositionstart="fields.label.composing = true"
        @compositionend="compositionEnd('label', $event)"
      />
      <p v-if="fields.label.remoteChanged" class="field-notice">
        标题有远端更新。继续输入将提交当前文本，离开输入框可查看最新内容。
      </p>
    </div>
    <div class="field-group">
      <label for="node-content">说明 <span>支持换行</span></label>
      <textarea
        id="node-content"
        :value="fields.content.value"
        rows="9"
        maxlength="10000"
        placeholder="描述这个模块的职责、想法或待办…"
        @input="input('content', $event)"
        @focus="fields.content.focused = true"
        @blur="blur('content')"
        @compositionstart="fields.content.composing = true"
        @compositionend="compositionEnd('content', $event)"
      />
      <p v-if="fields.content.remoteChanged" class="field-notice">
        说明有远端更新。继续输入将提交当前文本，离开输入框可查看最新内容。
      </p>
    </div>
    <fieldset class="color-picker">
      <legend>卡片颜色</legend>
      <button
        v-for="color in nodeColors"
        :key="color"
        :class="['color-swatch', `tone-${color}`]"
        :aria-label="colorNames[color]"
        :aria-pressed="node.data.color === color"
        :title="colorNames[color]"
        @click="selectColor(color)"
      >
        <BoardIcon v-if="node.data.color === color" name="check" />
      </button>
    </fieldset>
    <div class="details-footer">
      <button class="secondary-button" @click="duplicate"><BoardIcon name="copy" />复制卡片</button>
      <button class="text-button danger-text" @click="emit('delete')">
        <BoardIcon name="trash" />删除
      </button>
    </div>
    <p class="detail-footnote">标题和说明分别同步。多人同时改同一个字段时，最终保留一个版本。</p>
  </aside>
</template>
