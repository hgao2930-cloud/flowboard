<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { ConnectionMode, MarkerType, VueFlow, useVueFlow } from '@vue-flow/core'
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  NodeDragEvent,
  NodeMouseEvent,
} from '@vue-flow/core'
import createSession from '@/collaboration/session'
import { createRemoteMotion } from '@/collaboration/remoteMotion'
import type {
  ConnectionState,
  HistoryState,
  NodeDataPatch,
  Point,
  RoomMember,
  SharedNode,
} from '@/collaboration/session'
import type { GraphSnapshot } from '@/collaboration/document'
import BoardIcon from '@/components/BoardIcon.vue'
import BoardCard from '@/components/BoardCard.vue'
import NodeDetailsDrawer from '@/components/NodeDetailsDrawer.vue'
import '@/assets/board.css'
import { recordBoardVisit, removeRecentBoard, STORAGE_NOTICE } from '@/rooms/recentBoards'
import { deleteRoom, getRoom, retryRoomSave, RoomApiError } from '@/rooms/api'
import {
  readManagementToken,
  removeManagementToken,
  isManagementTokenTemporary,
  CREDENTIAL_NOTICE,
} from '@/rooms/management'

const route = useRoute()
const roomId = String(route.params.roomId)
const roomTitle = ref('')
const entryError = ref('')
const entryMessage = ref('正在确认房间…')
let entryTimer: ReturnType<typeof setTimeout> | undefined
const storageNotice = ref('')
const managementToken = ref(readManagementToken(roomId))
const credentialNotice = ref(isManagementTokenTemporary(roomId) ? CREDENTIAL_NOTICE : '')
const roomDeleted = ref(false)
const deletingRoom = ref(false)
const deleteError = ref('')
const saveState = ref<'saved' | 'pending' | 'error' | 'too_large' | 'unknown'>('unknown')
const capacityIssue = ref<'message' | 'document' | null>(null)
const capacityNotice = computed(() =>
  capacityIssue.value === 'document'
    ? '白板超过容量上限，已暂停协作和保存，重试保存无法解决。请先复制重要内容，再联系维护者处理或由房主删除房间；未保存修改可能仅在内存中。'
    : '同步内容超过消息容量，已停止自动重连。未同步改动仍在本页，请勿刷新；请先复制重要内容，再联系维护者调整限制。',
)
const savedAt = ref<number | null>(null)
const retryingSave = ref(false)
let stateTimer: ReturnType<typeof setInterval> | undefined
let queryingState = false
let visitRecorded = false
const {
  applyNodeChanges,
  applyEdgeChanges,
  getSelectedNodes,
  getSelectedEdges,
  getNodes,
  viewport,
  project,
  fitView,
  zoomIn,
  zoomOut,
  setCenter,
} = useVueFlow({ id: `board-${roomId}`, applyDefault: false })
type BoardNode = Node<SharedNode['data']> & SharedNode
const nodes = shallowRef<BoardNode[]>([])
const edges = shallowRef<(Edge & { selected?: boolean })[]>([])
const members = ref<RoomMember[]>([])
const connection = ref<ConnectionState>({ status: 'connecting', synced: false })
const history = ref<HistoryState>({ canUndo: false, canRedo: false })
const hasSynced = ref(false)
const editingNodeId = ref<string | null>(null)
const drawer = ref<InstanceType<typeof NodeDetailsDrawer> | null>(null)
const canvas = ref<HTMLElement | null>(null)
const notice = ref('')
const shareFallback = ref(false)
const shareUrl = window.location.href
function exportBoard() {
  if (!session) return
  const graph = session.snapshot()
  const file = {
    format: 'flowboard',
    version: 1,
    title: roomTitle.value || '未命名白板',
    nodes: graph.nodes,
    edges: graph.edges,
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${file.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}.flowboard.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  notify('已导出本机当前白板内容。')
}
const nickname = ref(readNickname())
const nicknameInput = ref(nickname.value)
const nicknameError = ref('')
const panel = ref<'members' | 'help' | 'manage' | null>(null)
let session: ReturnType<typeof createSession> | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let cursorTimer: ReturnType<typeof setTimeout> | undefined
let pendingCursor: Point | null = null
let fitted = false
let alive = true
const draggingPositions = new Map<string, Point>()
let graphFrame: number | undefined
let pendingGraph: GraphSnapshot | null = null
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const remoteMotion = createRemoteMotion((positions) => {
  if (!alive || roomDeleted.value) return
  nodes.value = nodes.value.map((node) => {
    const position = positions.get(node.id)
    return position && !draggingPositions.has(node.id) ? { ...node, position } : node
  })
})

const editingNode = computed(
  () => nodes.value.find((node) => node.id === editingNodeId.value) ?? null,
)
const remoteMembers = computed(() => members.value.filter((member) => !member.isSelf))
const selectedCount = computed(() => getSelectedNodes.value.length + getSelectedEdges.value.length)
const historyBlocked = computed(() =>
  remoteMembers.value.some((m) => m.editingNodeId || m.draggingNodeIds.length),
)
const connectionText = computed(() =>
  connection.value.status === 'connected'
    ? connection.value.synced
      ? '协作已连接'
      : '正在同步'
    : connection.value.status === 'connecting'
      ? '正在连接'
      : '连接已断开',
)
const fullyConnected = computed(
  () => connection.value.status === 'connected' && connection.value.synced,
)
const editorsByNode = computed(() => {
  const result = new Map<string, RoomMember[]>()
  for (const member of members.value) {
    if (!member.editingNodeId) continue
    const list = result.get(member.editingNodeId) ?? []
    list.push(member)
    result.set(member.editingNodeId, list)
  }
  return result
})
const draggingByNode = computed(() => {
  const result = new Map<string, RoomMember[]>()
  for (const member of members.value)
    for (const id of member.draggingNodeIds) {
      const list = result.get(id) ?? []
      list.push(member)
      result.set(id, list)
    }
  return result
})
const cursorMembers = computed(() => remoteMembers.value.filter((m) => m.cursor !== null))

function readNickname() {
  try {
    return (
      sessionStorage.getItem('flowboard.nickname') ||
      `访客-${Math.floor(Math.random() * 9000) + 1000}`
    )
  } catch {
    return '访客'
  }
}
function notify(message: string) {
  notice.value = message
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 4500)
}
function applyGraph(graph: GraphSnapshot, local = true) {
  // 文档始终实时合并；只有远端的显示更新合并到下一帧。
  if (!local && hasSynced.value) {
    pendingGraph = graph
    if (graphFrame === undefined)
      graphFrame = requestAnimationFrame(() => {
        graphFrame = undefined
        const latest = pendingGraph
        pendingGraph = null
        if (latest && alive && !roomDeleted.value) renderGraph(latest, true)
      })
    return
  }
  // 本地新快照已包含之前收到的更新，不能让旧的排队快照覆盖它。
  pendingGraph = null
  if (graphFrame !== undefined) cancelAnimationFrame(graphFrame)
  graphFrame = undefined
  renderGraph(graph, false)
}
function renderGraph(graph: GraphSnapshot, animate: boolean) {
  const localNodes = new Map(getNodes.value.map((node) => [node.id, node]))
  const selectedEdges = new Set(getSelectedEdges.value.map((edge) => edge.id))
  const displayed = new Map(nodes.value.map((node) => [node.id, node]))
  remoteMotion.retain(new Set(graph.nodes.map((node) => node.id)))
  nodes.value = graph.nodes.map((node) => {
    const previous = displayed.get(node.id)
    let position = draggingPositions.get(node.id) ?? node.position
    if (animate && previous && !draggingPositions.has(node.id) && !reducedMotion.matches) {
      remoteMotion.move(node.id, previous.position, node.position)
      position = previous.position
    } else remoteMotion.remove(node.id)
    return { ...node, type: 'card', position, selected: localNodes.get(node.id)?.selected ?? false }
  })
  const nextEdges = graph.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    selected: selectedEdges.has(edge.id),
    markerEnd: MarkerType.ArrowClosed,
    style: { stroke: '#91a49c', strokeWidth: 1.7 },
  }))
  // 拖动只改变节点位置，不重复重建 Vue Flow 的连线数据。
  if (
    nextEdges.length !== edges.value.length ||
    nextEdges.some((edge, i) => {
      const old = edges.value[i]
      return (
        !old ||
        edge.id !== old.id ||
        edge.source !== old.source ||
        edge.target !== old.target ||
        edge.sourceHandle !== old.sourceHandle ||
        edge.targetHandle !== old.targetHandle ||
        edge.selected !== old.selected
      )
    })
  )
    edges.value = nextEdges
  if (editingNodeId.value && !graph.nodes.some((node) => node.id === editingNodeId.value)) {
    editingNodeId.value = null
    session?.setEditingNodeId(null)
    notify('这张卡片已被移除。')
  }
  for (const id of draggingPositions.keys())
    if (!graph.nodes.some((node) => node.id === id)) draggingPositions.delete(id)
}
function closeDetails() {
  drawer.value?.finishComposition()
  editingNodeId.value = null
  session?.setEditingNodeId(null)
  session?.stopCapturing()
}
function handlePaneClick() {
  closeDetails()
  panel.value = null
  canvas.value?.focus({ preventScroll: true })
}
function selectDetails(id: string) {
  if (editingNodeId.value === id) return
  closeDetails()
  if (!nodes.value.some((node) => node.id === id)) return
  editingNodeId.value = id
  session?.setEditingNodeId(id)
}
function openDetails({ node }: NodeMouseEvent) {
  if (hasSynced.value) selectDetails(node.id)
}
function updateNodeData(id: string, patch: NodeDataPatch) {
  return session?.updateNodeData(id, patch) ?? false
}
function createElementId() {
  // 公网 IP 使用 HTTP 时没有 randomUUID；getRandomValues 仍可用。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function addNode() {
  if (!hasSynced.value || !session || !canvas.value) return
  const rect = canvas.value.getBoundingClientRect()
  const center = project({ x: rect.width / 2, y: rect.height / 2 })
  let position = { x: center.x - 120, y: center.y - 80 }
  while (
    nodes.value.some(
      (node) =>
        Math.abs(node.position.x - position.x) < 30 && Math.abs(node.position.y - position.y) < 30,
    )
  ) {
    position = { x: position.x + 36, y: position.y + 36 }
  }
  const id = createElementId()
  session.addNode({ id, position, data: { label: '新卡片', content: '', color: 'mint' } })
  selectDetails(id)
}
function duplicateNode() {
  const node = editingNode.value
  if (!node || !session) return
  const id = createElementId()
  session.addNode({
    id,
    position: { x: node.position.x + 48, y: node.position.y + 48 },
    data: { ...node.data, label: `${node.data.label || '未命名卡片'} · 副本` },
  })
  selectDetails(id)
}
function deleteElements(nodeIds: string[], edgeIds: string[]) {
  if (!hasSynced.value) return
  const blocked = session?.deleteElements(nodeIds, edgeIds) ?? []
  if (blocked.length) notify(`${blocked.join('、')} 正在操作，已保留对应卡片和连线。`)
}
function deleteSelection() {
  deleteElements(
    getSelectedNodes.value.map((node) => node.id),
    getSelectedEdges.value.map((edge) => edge.id),
  )
}
function handleNodesChange(changes: NodeChange[]) {
  applyNodeChanges(changes.filter((change) => change.type !== 'remove'))
  // Vue Flow 的方向键移动不会触发 node-drag，也要写入共享坐标。
  const keyboardMoves = changes.flatMap((change) =>
    change.type === 'position' &&
    change.position &&
    change.dragging === false &&
    !draggingPositions.has(change.id)
      ? [{ id: change.id, position: { ...change.position } }]
      : [],
  )
  if (keyboardMoves.length && hasSynced.value) {
    session?.stopCapturing()
    session?.updatePositions(keyboardMoves)
    session?.stopCapturing()
  }
  const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
  if (removed.length) deleteElements(removed, [])
}
function handleEdgesChange(changes: EdgeChange[]) {
  applyEdgeChanges(changes.filter((change) => change.type !== 'remove'))
  const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
  if (removed.length) deleteElements([], removed)
}
function connect(connection: Connection) {
  if (!hasSynced.value) return
  const error = session?.addEdge({ ...connection, id: createElementId() })
  if (error) notify(error)
}
function dragStart(event: NodeDragEvent) {
  session?.stopCapturing()
  const moving = event.nodes.length ? event.nodes : [event.node]
  for (const node of moving) {
    remoteMotion.remove(node.id)
    draggingPositions.set(node.id, { ...node.position })
  }
  session?.setDraggingNodeIds(moving.map((node) => node.id))
}
function drag(event: NodeDragEvent) {
  const moving = event.nodes.length ? event.nodes : [event.node]
  for (const node of moving) draggingPositions.set(node.id, { ...node.position })
  session?.updatePositions(moving.map((node) => ({ id: node.id, position: { ...node.position } })))
}
function dragStop(event: NodeDragEvent) {
  drag(event)
  stopDrag()
}
function stopDrag() {
  if (!draggingPositions.size) return
  draggingPositions.clear()
  session?.setDraggingNodeIds([])
  session?.stopCapturing()
  if (session) applyGraph(session.snapshot())
}
function historyAction(direction: 'undo' | 'redo') {
  if (!hasSynced.value) return
  stopDrag()
  drawer.value?.finishComposition()
  if (!session?.changeHistory(direction)) notify('其他成员正在操作，稍后再撤销或重做。')
}
function handleKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  const target = event.target
  if (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"]')
  )
    return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelection()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    historyAction(event.shiftKey ? 'redo' : 'undo')
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    historyAction('redo')
  } else if (event.key === 'Escape') {
    closeDetails()
    panel.value = null
  }
}
function pointerMove(event: PointerEvent) {
  if (!fullyConnected.value || !canvas.value || event.pointerType === 'touch') return
  const rect = canvas.value.getBoundingClientRect()
  pendingCursor = {
    x: (event.clientX - rect.left - viewport.value.x) / viewport.value.zoom,
    y: (event.clientY - rect.top - viewport.value.y) / viewport.value.zoom,
  }
  if (cursorTimer !== undefined) return
  cursorTimer = setTimeout(() => {
    cursorTimer = undefined
    session?.setCursor(pendingCursor)
  }, 50)
}
function clearCursor() {
  clearTimeout(cursorTimer)
  cursorTimer = undefined
  pendingCursor = null
  session?.setCursor(null)
}
function cursorStyle(member: RoomMember) {
  return {
    color: member.color,
    transform: `translate(${(member.cursor?.x ?? 0) * viewport.value.zoom + viewport.value.x}px, ${(member.cursor?.y ?? 0) * viewport.value.zoom + viewport.value.y}px)`,
  }
}
function saveNickname() {
  const name = nicknameInput.value.trim()
  if (!name) {
    nicknameError.value = '请输入昵称'
    return
  }
  nickname.value = name
  nicknameInput.value = name
  nicknameError.value = ''
  try {
    sessionStorage.setItem('flowboard.nickname', name)
  } catch {
    /* 存储不可用仍可更新在线昵称。 */
  }
  session?.setNickname(name)
  notify('昵称已更新。')
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl)
    if (alive) notify('房间链接已复制。')
  } catch {
    if (alive) shareFallback.value = true
  }
}
function fitCanvas() {
  void fitView({ padding: 0.22, maxZoom: 1, duration: 250 })
}
function fitInitially() {
  if (
    fitted ||
    !hasSynced.value ||
    !nodes.value.length ||
    getNodes.value.some((node) => !node.dimensions.width || !node.dimensions.height)
  )
    return
  fitted = true
  fitCanvas()
}
function locateMember(member: RoomMember) {
  const node = nodes.value.find(
    (node) => node.id === (member.editingNodeId || member.draggingNodeIds[0]),
  )
  if (node) {
    void setCenter(node.position.x + 120, node.position.y + 80, { zoom: 1, duration: 300 })
    panel.value = null
  }
}
function windowBlur() {
  clearCursor()
  stopDrag()
}

function failEntry(message: string) {
  if (!alive || hasSynced.value || entryError.value || capacityIssue.value) return
  entryError.value = message
  clearTimeout(entryTimer)
  session?.destroy()
  session = null
}

function markCapacityExceeded(kind: 'message' | 'document') {
  if (!alive || roomDeleted.value) return
  capacityIssue.value = kind
  clearTimeout(entryTimer)
  session?.disconnect()
  if (!hasSynced.value) entryError.value = capacityNotice.value
}

function markRoomDeleted() {
  if (!alive || roomDeleted.value) return
  roomDeleted.value = true
  remoteMotion.clear()
  if (graphFrame !== undefined) cancelAnimationFrame(graphFrame)
  graphFrame = undefined
  pendingGraph = null
  if (managementToken.value) {
    const credentialRemoved = removeManagementToken(roomId)
    const historyRemoved = removeRecentBoard(roomId)
    if (!credentialRemoved || historyRemoved.storageUnavailable) {
      storageNotice.value = '房间已删除，但本机存储清理失败；请手动移除残留入口。'
    }
    managementToken.value = null
  }
  clearTimeout(entryTimer)
  clearInterval(stateTimer)
  const previous = session
  session = null
  previous?.destroy()
}

async function refreshRoomState() {
  if (!alive || roomDeleted.value || queryingState) return
  queryingState = true
  try {
    const room = await getRoom(roomId)
    if (!alive || roomDeleted.value) return
    saveState.value = room.saveState ?? 'unknown'
    savedAt.value = room.savedAt ?? null
    if (room.saveState === 'too_large') markCapacityExceeded('document')
  } catch (error) {
    if (!alive || roomDeleted.value) return
    if (error instanceof RoomApiError && error.status === 404) markRoomDeleted()
    else {
      saveState.value = error instanceof RoomApiError ? (error.saveState ?? 'unknown') : 'unknown'
      if (saveState.value === 'too_large') markCapacityExceeded('document')
    }
  } finally {
    queryingState = false
  }
}

async function retrySave() {
  if (retryingSave.value) return
  retryingSave.value = true
  try {
    await retryRoomSave(roomId)
    await refreshRoomState()
  } catch (error) {
    if (error instanceof RoomApiError && error.status === 404) markRoomDeleted()
    else if (error instanceof RoomApiError && error.saveState === 'too_large')
      markCapacityExceeded('document')
    else notify(error instanceof Error ? error.message : '保存未成功。')
  } finally {
    retryingSave.value = false
  }
}

async function confirmDeleteRoom() {
  if (!managementToken.value || deletingRoom.value) return
  if (!window.confirm(`删除“${roomTitle.value}”？所有协作者的共享内容都会被永久删除，无法恢复。`))
    return
  deletingRoom.value = true
  deleteError.value = ''
  try {
    await deleteRoom(roomId, managementToken.value)
    // WebSocket 通知与 HTTP 响应都走同一个幂等清理入口。
    markRoomDeleted()
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : '删除未确认成功，请稍后重试。'
  } finally {
    deletingRoom.value = false
  }
}

async function enterRoom() {
  entryError.value = ''
  entryMessage.value = '正在确认房间…'
  try {
    // 直接访问链接、刷新和重试也走检查，不依赖首页预先查询过。
    const room = await getRoom(roomId)
    if (!alive) return
    roomTitle.value = room.title
    saveState.value = room.saveState ?? 'unknown'
    savedAt.value = room.savedAt ?? null
    if (room.saveState === 'too_large') {
      markCapacityExceeded('document')
      return
    }
  } catch (error) {
    if (error instanceof RoomApiError && error.status === 404) {
      markRoomDeleted()
      return
    }
    failEntry(error instanceof Error ? error.message : '无法查询房间，请稍后重试。')
    return
  }
  entryMessage.value = '正在连接协作服务…'
  entryTimer = setTimeout(() => failEntry('连接或同步超时，请检查网络后重试。'), 10000)
  try {
    session = createSession({
      roomId,
      nickname: nickname.value,
      onGraphChange: applyGraph,
      onMembersChange: (value) => {
        members.value = value
      },
      onHistoryChange: (value) => {
        history.value = value
      },
      onConnectionFailure: () => {
        failEntry('协作连接失败，请确认服务可用后重试。')
        void refreshRoomState()
      },
      onRoomDeleted: markRoomDeleted,
      onCapacityExceeded: markCapacityExceeded,
      onConnectionChange: (value) => {
        if (!alive || roomDeleted.value) return
        connection.value = value
        if (value.status === 'connected' && !value.synced) entryMessage.value = '正在同步白板内容…'
        if (!visitRecorded && value.status === 'connected' && value.synced) {
          visitRecorded = true
          if (recordBoardVisit(roomId, roomTitle.value).storageUnavailable) {
            storageNotice.value = STORAGE_NOTICE
          }
        }
        if (value.status === 'connected' && value.synced) {
          clearTimeout(entryTimer)
          hasSynced.value = true
          void nextTick(() => {
            if (alive) fitInitially()
          })
        }
      },
    })
  } catch {
    failEntry('无法建立协作连接，请检查服务地址后重试。')
  }
}

onMounted(() => {
  void enterRoom()
  stateTimer = setInterval(() => {
    void refreshRoomState()
  }, 4000)
  window.addEventListener('blur', windowBlur)
})
onBeforeRouteLeave(() => {
  closeDetails()
})
onBeforeUnmount(() => {
  alive = false
  remoteMotion.clear()
  if (graphFrame !== undefined) cancelAnimationFrame(graphFrame)
  pendingGraph = null
  window.removeEventListener('blur', windowBlur)
  clearTimeout(noticeTimer)
  clearTimeout(cursorTimer)
  clearTimeout(entryTimer)
  clearInterval(stateTimer)
  session?.destroy()
  session = null
})
</script>

<template>
  <main
    v-if="roomDeleted || !hasSynced"
    class="board-entry"
    :aria-busy="!roomDeleted && !entryError"
  >
    <section class="board-entry-card">
      <span class="eyebrow">FLOWBOARD</span>
      <h1>{{ roomDeleted ? '房间已删除' : entryError ? '暂时无法进入白板' : '正在进入白板' }}</h1>
      <p class="board-entry-room">{{ roomTitle || roomId }}</p>
      <p v-if="roomDeleted" role="status">房间已删除或不存在，旧链接不能重新创建房间。</p>
      <p v-else-if="entryError" role="alert">{{ entryError }}</p>
      <p v-else role="status">{{ entryMessage }}</p>
      <p v-if="storageNotice" role="status">{{ storageNotice }}</p>
      <p v-if="credentialNotice" role="alert">{{ credentialNotice }}</p>
      <p v-if="deleteError" role="alert">{{ deleteError }}</p>
      <div class="board-entry-actions">
        <button
          v-if="entryError && !roomDeleted && !capacityIssue"
          type="button"
          @click="enterRoom"
        >
          重新尝试
        </button>
        <button
          v-if="saveState === 'error' && !roomDeleted && !capacityIssue"
          type="button"
          :disabled="retryingSave"
          @click="retrySave"
        >
          重试保存
        </button>
        <RouterLink to="/">返回首页</RouterLink>
        <button
          v-if="managementToken && !roomDeleted"
          type="button"
          :disabled="deletingRoom"
          @click="confirmDeleteRoom"
        >
          删除整个房间
        </button>
      </div>
    </section>
  </main>
  <main v-else class="board-page" @keydown="handleKeydown">
    <header class="board-header">
      <RouterLink class="brand-mark" to="/" aria-label="返回主页"
        ><span class="brand-symbol">f<span>·</span></span
        ><span class="brand-name">flowboard</span></RouterLink
      >
      <span class="header-divider"></span>
      <div class="room-heading">
        <span class="eyebrow">SHARED WORKSPACE</span>
        <h1 :title="`房间号：${roomId}`">{{ roomTitle }}</h1>
      </div>
      <div class="header-actions">
        <div class="popover-anchor">
          <button
            class="secondary-button"
            :aria-expanded="panel === 'manage'"
            @click="panel = panel === 'manage' ? null : 'manage'"
          >
            房间管理
          </button>
          <section v-if="panel === 'manage'" class="board-popover" aria-label="房间管理">
            <h2>房间管理</h2>
            <p class="small muted">房间号：{{ roomId }}</p>
            <p class="small muted">
              管理权来自此浏览器保存的凭证。清理浏览器数据或更换设备后无法找回。
            </p>
            <button
              v-if="managementToken"
              class="secondary-button danger-text"
              :disabled="deletingRoom"
              @click="confirmDeleteRoom"
            >
              {{ deletingRoom ? '正在删除…' : '删除整个房间' }}
            </button>
            <p v-else class="small muted">此浏览器没有该房间的管理凭证。</p>
            <p v-if="deleteError" class="danger-text small" role="alert">{{ deleteError }}</p>
          </section>
        </div>
        <span class="connection-badge" :class="{ online: fullyConnected }" role="status"
          ><span class="live-dot"></span>{{ connectionText }}</span
        >
        <div class="popover-anchor">
          <button
            class="members-button"
            :aria-expanded="panel === 'members'"
            aria-label="查看协作成员和修改昵称"
            @click="panel = panel === 'members' ? null : 'members'"
          >
            <span class="avatar-stack"
              ><span
                v-for="member in members.slice(0, 3)"
                :key="member.clientId"
                class="avatar"
                :style="{ background: member.color }"
                >{{ member.name.slice(0, 1) }}</span
              ></span
            >
            <span>{{ members.length }} 位在线</span>
          </button>
          <section v-if="panel === 'members'" class="board-popover" aria-label="协作成员">
            <div class="popover-heading">
              <h2>一起创作</h2>
              <button class="icon-button" aria-label="关闭成员列表" @click="panel = null">
                <BoardIcon name="close" />
              </button>
            </div>
            <p class="muted small">每个打开的客户端独立显示。</p>
            <ul class="member-list">
              <li v-for="member in members" :key="member.clientId">
                <button @click="locateMember(member)">
                  <span class="avatar" :style="{ background: member.color }">{{
                    member.name.slice(0, 1)
                  }}</span>
                  <span class="member-info"
                    ><strong>{{ member.name }}<small v-if="member.isSelf">（你）</small></strong
                    ><small>{{
                      member.draggingNodeIds.length
                        ? '正在移动卡片'
                        : member.editingNodeId
                          ? '正在编辑卡片'
                          : '正在浏览'
                    }}</small></span
                  >
                  <BoardIcon
                    v-if="member.editingNodeId || member.draggingNodeIds.length"
                    name="chevron"
                  />
                </button>
              </li>
            </ul>
            <form class="nickname-form" @submit.prevent="saveNickname">
              <label for="nickname">你的昵称</label>
              <div>
                <input
                  id="nickname"
                  v-model="nicknameInput"
                  maxlength="24"
                  autocomplete="nickname"
                /><button class="secondary-button">更新</button>
              </div>
              <p v-if="nicknameError" class="danger-text small">{{ nicknameError }}</p>
            </form>
          </section>
        </div>
        <button class="secondary-button" :disabled="!session" @click="exportBoard">
          导出 JSON
        </button>
        <button class="primary-button share-button" @click="copyLink">
          <BoardIcon name="link" /><span>复制房间链接</span>
        </button>
      </div>
    </header>

    <div v-if="storageNotice" class="connection-banner" role="status">{{ storageNotice }}</div>
    <div v-if="credentialNotice" class="connection-banner" role="alert">{{ credentialNotice }}</div>
    <div v-if="capacityIssue" class="connection-banner" role="alert">{{ capacityNotice }}</div>
    <div
      v-else-if="saveState === 'error' || saveState === 'unknown'"
      class="connection-banner"
      role="status"
    >
      {{
        saveState === 'error'
          ? '数据库保存失败，未保存内容暂留服务端内存；请勿关闭服务。'
          : '暂无法确认数据库保存状态，请勿刷新或关闭页面。'
      }}
      <button
        v-if="saveState === 'error'"
        class="text-button"
        :disabled="retryingSave"
        @click="retrySave"
      >
        重试保存
      </button>
    </div>
    <div v-if="!fullyConnected && !capacityIssue" class="connection-banner" role="status">
      <span class="live-dot"></span>
      {{
        hasSynced
          ? '连接恢复中。可以继续编辑，当前改动暂存在本页，请勿刷新；重连后自动同步。'
          : '正在连接协作房间，首次同步完成后即可编辑。'
      }}
    </div>
    <div v-if="shareFallback" class="share-fallback">
      <label for="share-link">复制此地址邀请协作者</label
      ><input
        id="share-link"
        :value="shareUrl"
        readonly
        @focus="($event.target as HTMLInputElement).select()"
      /><button class="icon-button" aria-label="关闭分享地址" @click="shareFallback = false">
        <BoardIcon name="close" />
      </button>
    </div>

    <div class="board-body">
      <NodeDetailsDrawer
        v-if="editingNode"
        :key="editingNode.id"
        ref="drawer"
        :node="editingNode"
        :editors="(editorsByNode.get(editingNode.id) ?? []).filter((m) => !m.isSelf)"
        :update="updateNodeData"
        @close="closeDetails"
        @delete="deleteElements([editingNode.id], [])"
        @duplicate="duplicateNode"
        @end-edit="session?.stopCapturing()"
      />

      <section
        ref="canvas"
        class="canvas-container"
        tabindex="0"
        aria-label="协作画布"
        @pointermove="pointerMove"
        @pointerleave="clearCursor"
        @pointerdown.self="canvas?.focus()"
      >
        <VueFlow
          :id="`board-${roomId}`"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :apply-default="false"
          :delete-key-code="null"
          :connection-mode="ConnectionMode.Strict"
          :min-zoom="0.2"
          :max-zoom="2"
          :nodes-draggable="hasSynced"
          :nodes-connectable="hasSynced"
          :snap-to-grid="false"
          @connect="connect"
          @nodes-change="handleNodesChange"
          @edges-change="handleEdgesChange"
          @node-click="openDetails"
          @pane-click="handlePaneClick"
          @node-drag-start="dragStart"
          @node-drag="drag"
          @node-drag-stop="dragStop"
          @nodes-initialized="fitInitially"
        >
          <template #node-card="{ id, data }"
            ><BoardCard
              :data="data"
              :editors="editorsByNode.get(id) ?? []"
              :dragging="draggingByNode.get(id) ?? []"
          /></template>
        </VueFlow>

        <div class="canvas-toolbar" aria-label="画布工具">
          <button class="primary-button" :disabled="!hasSynced" @click="addNode">
            <BoardIcon name="plus" />添加卡片
          </button>
          <span class="toolbar-separator"></span>
          <button
            class="icon-button"
            :disabled="!history.canUndo || historyBlocked"
            :title="historyBlocked ? '其他成员正在操作，稍后再撤销' : '撤销我的操作 · Ctrl / ⌘ Z'"
            aria-label="撤销我的操作"
            @click="historyAction('undo')"
          >
            <BoardIcon name="undo" />
          </button>
          <button
            class="icon-button"
            :disabled="!history.canRedo || historyBlocked"
            title="重做 · Ctrl / ⌘ Shift Z"
            aria-label="重做我的操作"
            @click="historyAction('redo')"
          >
            <BoardIcon name="redo" />
          </button>
          <button
            class="icon-button danger-hover"
            :disabled="!selectedCount"
            title="删除选中项 · Delete"
            aria-label="删除选中项"
            @click="deleteSelection"
          >
            <BoardIcon name="trash" />
          </button>
        </div>

        <div v-if="hasSynced && !nodes.length" class="empty-board">
          <div class="empty-art">
            <div class="empty-card back"></div>
            <div class="empty-card front"><BoardIcon name="card" /><i></i><i></i></div>
            <span class="empty-spark">+</span>
          </div>
          <span class="eyebrow">A LITTLE SPACE FOR BIG IDEAS</span>
          <h2>从一个想法开始</h2>
          <p>添加卡片，连起思路。<br />邀请伙伴，把想法一起展开。</p>
          <button class="secondary-button" @click="addNode">
            <BoardIcon name="plus" />创建第一张卡片
          </button>
        </div>

        <div class="remote-cursors" aria-hidden="true">
          <div
            v-for="member in cursorMembers"
            :key="member.clientId"
            class="remote-cursor"
            :style="cursorStyle(member)"
          >
            <BoardIcon name="cursor" /><span :style="{ background: member.color }">{{
              member.name
            }}</span>
          </div>
        </div>
        <div v-if="notice" class="board-toast" role="status">
          {{ notice
          }}<button class="icon-button" aria-label="关闭提示" @click="notice = ''">
            <BoardIcon name="close" />
          </button>
        </div>

        <div class="canvas-bottom">
          <span class="canvas-tip">拖动空白处平移 <span>·</span> 从右侧圆点连向另一张卡片</span>
          <div class="zoom-controls">
            <button class="icon-button" aria-label="缩小" title="缩小" @click="zoomOut()">
              <BoardIcon name="minus" /></button
            ><span>{{ Math.round(viewport.zoom * 100) }}%</span
            ><button class="icon-button" aria-label="放大" title="放大" @click="zoomIn()">
              <BoardIcon name="plus" /></button
            ><span class="toolbar-separator"></span
            ><button
              class="icon-button"
              aria-label="适应全部卡片"
              title="适应全部卡片"
              :disabled="!nodes.length"
              @click="fitCanvas"
            >
              <BoardIcon name="fit" />
            </button>
          </div>
        </div>
      </section>
    </div>

    <footer class="board-footer">
      <span
        ><strong>{{ nodes.length }}</strong> 张卡片 <span class="footer-dot">·</span>
        <strong>{{ edges.length }}</strong> 条连线</span
      ><span class="storage-note">{{
        capacityIssue
          ? '容量超限 · 协作已暂停'
          : !fullyConnected
            ? '本页临时保留 · 等待连接'
            : saveState === 'pending'
              ? '等待写入数据库'
              : savedAt
                ? `服务端最近保存 ${new Date(savedAt).toLocaleTimeString()}`
                : '正在确认数据库保存状态'
      }}</span
      ><button
        class="text-button"
        :aria-expanded="panel === 'help'"
        @click="panel = panel === 'help' ? null : 'help'"
      >
        操作提示 <span class="keycap">?</span>
      </button>
    </footer>
    <section v-if="panel === 'help'" class="help-panel board-popover" aria-label="操作提示">
      <div class="popover-heading">
        <h2>让思路流动起来</h2>
        <button class="icon-button" aria-label="关闭操作提示" @click="panel = null">
          <BoardIcon name="close" />
        </button>
      </div>
      <dl>
        <dt>编辑卡片</dt>
        <dd>点击卡片，内容随输入同步</dd>
        <dt>连接模块</dt>
        <dd>从右侧圆点拖向另一张卡片左侧</dd>
        <dt>多选</dt>
        <dd>按住 Shift 拖框，或 Ctrl / ⌘ 点击</dd>
        <dt>删除</dt>
        <dd>选中后按 Delete / Backspace</dd>
        <dt>撤销</dt>
        <dd>画布内 Ctrl / ⌘ Z，只撤销自己的操作</dd>
      </dl>
      <p class="small muted">
        有人编辑或拖动的卡片会尽量避免误删。多人可以同时编辑；同一字段以最终同步结果为准。
      </p>
    </section>
  </main>
</template>
