<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { createRoom, getRoom } from '@/rooms/api'
import { parseRoomInput } from '@/rooms/roomId'
import { saveManagementToken } from '@/rooms/management'
import { MAX_IMPORT_BYTES, readBoardFile } from '../../../shared/boardFile.mjs'
import {
  LOCAL_NAME_LIMIT,
  readRecentBoards,
  removeRecentBoard,
  STORAGE_NOTICE,
} from '@/rooms/recentBoards'

const router = useRouter()
let alive = true
onBeforeUnmount(() => {
  alive = false
})
const title = ref('')
const invitation = ref('')
const createError = ref('')
const joinError = ref('')
const navigating = ref(false)
const importInput = ref<HTMLInputElement | null>(null)
const importError = ref('')
async function importBoard(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || navigating.value) return
  importError.value = ''
  navigating.value = true
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('导入文件不能超过 1 MiB。')
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      throw new Error('无法读取文件，请选择有效的 JSON 文件。')
    }
    const board = readBoardFile(raw)
    if (!alive) return
    const room = await createRoom(board.title, board)
    saveManagementToken(room.id, room.managementToken)
    if (alive) await router.push({ name: 'board', params: { roomId: room.id } })
  } catch (error) {
    importError.value = error instanceof Error ? error.message : '导入失败，请稍后重试。'
  } finally {
    navigating.value = false
  }
}
const initialRecords = readRecentBoards()
const recentBoards = ref(initialRecords.boards)
const storageMessage = ref(initialRecords.storageUnavailable ? STORAGE_NOTICE : '')
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

async function createBoard() {
  if (navigating.value) return
  createError.value = ''
  const name = title.value.trim()
  if (name.length > LOCAL_NAME_LIMIT) {
    createError.value = `白板名称最多 ${LOCAL_NAME_LIMIT} 字。`
    return
  }
  navigating.value = true
  try {
    const room = await createRoom(name || '未命名白板')
    saveManagementToken(room.id, room.managementToken)
    if (!alive) return
    await router.push({ name: 'board', params: { roomId: room.id } })
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '暂时无法打开白板，请稍后重试。'
  } finally {
    navigating.value = false
  }
}

async function joinBoard() {
  if (navigating.value) return
  joinError.value = ''
  const result = parseRoomInput(invitation.value, window.location.origin, import.meta.env.BASE_URL)
  if (result.error !== undefined) {
    joinError.value = result.error
    return
  }
  navigating.value = true
  try {
    const room = await getRoom(result.roomId)
    if (!alive) return
    await router.push({ name: 'board', params: { roomId: room.id } })
  } catch (error) {
    joinError.value = error instanceof Error ? error.message : '暂时无法打开白板，请稍后重试。'
  } finally {
    navigating.value = false
  }
}

function removeRecord(roomId: string) {
  const result = removeRecentBoard(roomId)
  recentBoards.value = result.boards
  storageMessage.value = result.storageUnavailable ? STORAGE_NOTICE : ''
}
</script>

<template>
  <main class="home-page">
    <div class="home-content">
      <header class="home-header">
        <RouterLink class="home-brand" to="/" aria-label="Flowboard 首页">
          <span class="brand-symbol" aria-hidden="true">f<span>·</span></span
          >flowboard
        </RouterLink>
        <span class="brand-note">给想法一点共同生长的空间</span>
      </header>

      <section class="home-intro" aria-labelledby="home-title">
        <span class="eyebrow">THINK TOGETHER, FLOW TOGETHER</span>
        <h1 id="home-title">把想法摆出来，<br />一起连成思路。</h1>
        <p>用卡片和连线整理架构、拆解问题，分享房间链接即可一起协作。</p>
      </section>

      <div class="entry-grid">
        <section class="entry-card" aria-labelledby="create-title">
          <span class="entry-symbol" aria-hidden="true">+</span>
          <h2 id="create-title">新建白板</h2>
          <p class="muted">从一张空白画布开始。</p>
          <form @submit.prevent="createBoard">
            <label for="local-name">白板名称 <span class="optional">（可选）</span></label>
            <input
              id="local-name"
              v-model="title"
              :maxlength="LOCAL_NAME_LIMIT"
              placeholder="例如：订单系统架构"
              :aria-invalid="Boolean(createError)"
              :aria-describedby="createError ? 'create-error' : 'local-name-hint'"
              @input="createError = ''"
            />
            <p id="local-name-hint" class="field-hint">
              最多 40 字，房间内共同显示；留空使用“未命名白板”。
            </p>
            <p v-if="createError" id="create-error" class="form-error" role="alert">
              {{ createError }}
            </p>
            <button class="primary-action" :disabled="navigating" type="submit">
              {{ navigating ? '正在处理…' : '新建白板' }} <span aria-hidden="true">↗</span>
            </button>
          </form>
          <div class="import-entry">
            <input
              ref="importInput"
              type="file"
              accept=".json,application/json"
              hidden
              @change="importBoard"
            />
            <button
              type="button"
              class="secondary-action import-button"
              :disabled="navigating"
              @click="importInput?.click()"
            >
              导入 JSON 为新白板
            </button>
            <p class="field-hint">最多 1 MiB，创建独立副本，不覆盖已有白板。</p>
            <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
          </div>
        </section>

        <section class="entry-card" aria-labelledby="join-title">
          <span class="entry-symbol" aria-hidden="true">↗</span>
          <h2 id="join-title">加入协作</h2>
          <p class="muted">已经有房间？和伙伴在同一张白板相遇。</p>
          <form @submit.prevent="joinBoard">
            <label for="room-invitation">房间号或完整白板链接</label>
            <input
              id="room-invitation"
              v-model="invitation"
              placeholder="房间号或本站白板链接"
              autocapitalize="off"
              spellcheck="false"
              :aria-invalid="Boolean(joinError)"
              :aria-describedby="joinError ? 'join-error' : 'room-hint'"
              @input="joinError = ''"
            />
            <p id="room-hint" class="field-hint">房间号区分大小写，只能加入已创建的房间。</p>
            <p v-if="joinError" id="join-error" class="form-error" role="alert">{{ joinError }}</p>
            <button class="secondary-action" :disabled="navigating" type="submit">
              {{ navigating ? '正在处理…' : '加入协作' }} <span aria-hidden="true">→</span>
            </button>
          </form>
        </section>
      </div>

      <section class="recent-section" aria-labelledby="recent-title">
        <div class="recent-heading">
          <h2 id="recent-title">最近访问</h2>
          <p class="muted">最近访问仅保存在此浏览器</p>
        </div>
        <p v-if="storageMessage" class="storage-message" role="status">{{ storageMessage }}</p>
        <ul v-if="recentBoards.length" class="recent-list">
          <li v-for="board in recentBoards" :key="board.roomId" class="recent-item">
            <div class="recent-info">
              <h3>{{ board.localName || `白板 · ${board.roomId}` }}</h3>
              <p class="room-id">房间号：{{ board.roomId }}</p>
              <p class="visit-time">
                最近访问：<time :datetime="new Date(board.lastVisitedAt).toISOString()">{{
                  dateFormat.format(board.lastVisitedAt)
                }}</time>
              </p>
            </div>
            <div class="recent-actions">
              <RouterLink
                :to="{ name: 'board', params: { roomId: board.roomId } }"
                :aria-label="`打开 ${board.localName || board.roomId}`"
                >打开</RouterLink
              >
              <button
                type="button"
                :aria-label="`移除 ${board.localName || board.roomId} 的本机记录`"
                @click="removeRecord(board.roomId)"
              >
                移除记录
              </button>
            </div>
          </li>
        </ul>
        <div v-else class="recent-empty">
          <p>还没有最近访问的白板。</p>
          <span>新建或加入房间，连接并同步成功后会出现在这里。</span>
        </div>
        <p class="history-hint">移除记录只会移除此浏览器中的入口，不会删除白板内容。</p>
      </section>

      <footer class="home-footer">
        最近访问仅是本机入口，不能代表最新编辑已保存。管理凭证保留在创建时使用的浏览器中。
      </footer>
    </div>
  </main>
</template>

<style scoped>
.import-entry {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid #e6ebe6;
}
.home-page input[type='file'] {
  display: none;
}
.import-entry .import-button {
  justify-content: center;
}
.home-page {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  min-height: 100vh;
  padding: 32px 28px 24px;
  box-sizing: border-box;
  background: #f8f9f5;
  color: #263d36;
  font:
    14px/1.6 'Segoe UI',
    'PingFang SC',
    'Microsoft YaHei',
    sans-serif;
}
.home-page * {
  box-sizing: border-box;
}
.home-content {
  max-width: 980px;
  margin: 0 auto;
}
.home-header,
.home-brand,
.recent-heading,
.recent-item,
.recent-actions {
  display: flex;
  align-items: center;
}
.home-header,
.recent-heading,
.recent-item {
  justify-content: space-between;
  gap: 20px;
}
.home-brand {
  gap: 10px;
  color: #263d36;
  font-size: 21px;
  font-weight: 700;
  text-decoration: none;
}
.brand-symbol {
  color: #28735c;
  font-size: 36px;
  font-style: italic;
  line-height: 1;
}
.brand-symbol span {
  color: #aac4a1;
}
.brand-note,
.muted,
.optional,
.field-hint,
.history-hint,
.home-footer {
  color: #6b7d73;
}
.brand-note {
  font-size: 12px;
}
.home-intro {
  padding: 72px 0 40px;
}
.eyebrow {
  color: #28735c;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 2px;
}
.home-intro h1 {
  margin: 14px 0;
  font-size: clamp(30px, 4.5vw, 46px);
  line-height: 1.35;
  font-weight: 600;
  letter-spacing: -1px;
}
.home-intro p {
  color: #6b7d73;
  margin: 18px 0 0;
}
.entry-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
}
.entry-card {
  padding: 28px;
  background: #fff;
  border: 1px solid #e0e7df;
  border-radius: 16px;
}
.entry-symbol {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #edf5ec;
  color: #28735c;
  font-size: 24px;
}
.entry-card h2 {
  margin: 18px 0 4px;
  font-size: 22px;
  font-weight: 600;
}
.entry-card > p {
  margin: 0 0 26px;
}
.home-page label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
}
.optional {
  font-weight: 400;
  font-size: 12px;
}
.home-page input {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid #cfdcd1;
  border-radius: 8px;
  background: #fff;
  color: #263d36;
  font: inherit;
}
.home-page input::placeholder {
  color: #91a095;
}
.home-page input[aria-invalid='true'] {
  border-color: #ad5555;
}
.field-hint {
  min-height: 38px;
  margin: 8px 0 16px;
  font-size: 12px;
}
.home-page button {
  cursor: pointer;
  font: inherit;
}
.primary-action,
.secondary-action {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 11px 16px;
  border: 1px solid #28735c;
  border-radius: 8px;
  font-weight: 600;
}
.primary-action {
  color: white;
  background: #28735c;
}
.primary-action:hover {
  background: #205d4b;
}
.secondary-action {
  color: #28735c;
  background: #f5f9f3;
}
.secondary-action:hover {
  background: #edf5ec;
}
.home-page button:disabled {
  opacity: 0.55;
  cursor: wait;
}
.form-error {
  color: #a44747;
  font-size: 12px;
  margin: 8px 0 14px;
}
.recent-section {
  margin-top: 48px;
}
.recent-heading h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.recent-heading p {
  margin: 0;
  font-size: 12px;
}
.recent-list {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  border-top: 1px solid #e0e7df;
}
.recent-item {
  padding: 20px 0;
  border-bottom: 1px solid #e0e7df;
}
.recent-info {
  min-width: 0;
}
.recent-info h3 {
  margin: 0 0 4px;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.room-id,
.visit-time {
  margin: 3px 0;
  color: #6b7d73;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.room-id {
  font-family: ui-monospace, monospace;
}
.recent-actions {
  gap: 18px;
  flex-shrink: 0;
}
.recent-actions a {
  color: #28735c;
  font-weight: 600;
  text-decoration: none;
}
.recent-actions button {
  padding: 4px 0;
  border: 0;
  background: none;
  color: #6b7d73;
  font-size: 12px;
}
.recent-actions button:hover {
  color: #a44747;
}
.recent-empty {
  margin-top: 18px;
  padding: 32px 20px;
  border: 1px dashed #d5dfd3;
  border-radius: 12px;
  text-align: center;
  color: #6b7d73;
}
.recent-empty p {
  margin: 0 0 6px;
  color: #4c6457;
}
.recent-empty span,
.history-hint {
  font-size: 12px;
}
.history-hint {
  margin: 14px 0 0;
}
.storage-message {
  padding: 10px 14px;
  color: #7a5d33;
  background: #faf2e2;
  border-radius: 8px;
}
.home-footer {
  margin-top: 48px;
  padding-top: 20px;
  border-top: 1px solid #e0e7df;
  font-size: 12px;
}
.home-page :is(button, a, input):focus-visible {
  outline: 3px solid #9ac6b4;
  outline-offset: 3px;
}
@media (max-width: 680px) {
  .home-page {
    padding: 24px 18px;
  }
  .brand-note {
    display: none;
  }
  .home-intro {
    padding-top: 48px;
  }
  .entry-grid {
    grid-template-columns: 1fr;
  }
  .entry-card {
    padding: 24px;
  }
  .recent-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
  .recent-item {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
