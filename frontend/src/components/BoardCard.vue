<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { SharedNode, RoomMember } from '@/collaboration/session'
import BoardIcon from './BoardIcon.vue'
defineProps<{ data: SharedNode['data']; editors: RoomMember[]; dragging: RoomMember[] }>()
</script>

<template>
  <article
    :class="[
      'board-card',
      `tone-${data.color}`,
      { 'is-occupied': editors.length || dragging.length },
    ]"
  >
    <Handle type="target" :position="Position.Left" aria-label="输入端点" />
    <div class="card-accent"></div>
    <div class="card-heading">
      <span class="card-glyph"><BoardIcon name="card" /></span
      ><span class="card-type">模块 / 想法</span>
    </div>
    <h3 :class="{ 'placeholder-text': !data.label.trim() }">
      {{ data.label.trim() || '未命名卡片' }}
    </h3>
    <p class="card-description" :class="{ 'placeholder-text': !data.content }">
      {{ data.content || '点击卡片，补充你的想法…' }}
    </p>
    <div v-if="editors.length || dragging.length" class="card-presence">
      <span class="presence-pip" :style="{ background: (dragging[0] || editors[0])?.color }"></span>
      <span>{{
        dragging.length
          ? dragging.map((m) => (m.isSelf ? '你' : m.name)).join('、') + ' 正在移动'
          : editors.map((m) => (m.isSelf ? '你' : m.name)).join('、') + ' 正在编辑'
      }}</span>
    </div>
    <Handle type="source" :position="Position.Right" aria-label="输出端点" />
  </article>
</template>
