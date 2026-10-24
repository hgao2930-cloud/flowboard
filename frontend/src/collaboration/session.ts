import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { createBoardDocument, isPoint, isRecord } from './document'
import type { GraphSnapshot, HistoryState, Point } from './document'
import { planDeletion } from './deletion'
export type {
  SharedNode,
  SharedEdge,
  NodeDataPatch,
  NodeColor,
  Point,
  HistoryState,
} from './document'

export interface RoomMember {
  clientId: number
  name: string
  color: string
  isSelf: boolean
  editingNodeId: string | null
  draggingNodeIds: string[]
  cursor: Point | null
}
export interface ConnectionState {
  status: 'connecting' | 'connected' | 'disconnected'
  synced: boolean
}
interface SessionOptions {
  roomId: string
  nickname: string
  onGraphChange: (graph: GraphSnapshot, local?: boolean) => void
  onMembersChange: (members: RoomMember[]) => void
  onConnectionChange: (state: ConnectionState) => void
  onHistoryChange: (state: HistoryState) => void
  onConnectionFailure?: () => void
  onRoomDeleted?: () => void
  onCapacityExceeded?: (kind: 'message' | 'document') => void
}
const memberColors = ['#317969', '#6860bc', '#b35b79', '#377dad', '#ac732e', '#946446']

export default function createSession(options: SessionOptions) {
  const doc = new Y.Doc()
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const defaultUrl = import.meta.env.PROD
    ? `${protocol}://${location.host}${import.meta.env.BASE_URL}ws`
    : `${protocol}://${location.hostname}:3000`
  const provider = new WebsocketProvider(
    import.meta.env.VITE_WS_URL || defaultUrl,
    options.roomId,
    doc,
    // 同步统一经过服务端，避免同浏览器标签页绕过房间连接检查。
    { connect: false, disableBc: true },
  )
  const awareness = provider.awareness
  let destroyed = false
  const state: ConnectionState = { status: 'connecting', synced: false }
  const board = createBoardDocument(
    doc,
    (graph, localChange) => {
      const local = awareness.getLocalState()
      if (
        typeof local?.editingNodeId === 'string' &&
        !graph.nodes.some((n) => n.id === local.editingNodeId)
      ) {
        setEditingNodeId(null)
      }
      options.onGraphChange(graph, localChange)
    },
    options.onHistoryChange,
  )

  function readMembers(): RoomMember[] {
    return [...awareness.getStates()]
      .map(([clientId, presence]) => {
        const user = presence.user
        return {
          clientId,
          name:
            isRecord(user) && typeof user.name === 'string' && user.name.trim()
              ? user.name.slice(0, 24)
              : `访客-${clientId.toString().slice(-4)}`,
          color: memberColors[clientId % memberColors.length]!,
          isSelf: clientId === doc.clientID,
          editingNodeId: typeof presence.editingNodeId === 'string' ? presence.editingNodeId : null,
          draggingNodeIds: Array.isArray(presence.draggingNodeIds)
            ? presence.draggingNodeIds.filter((id: unknown): id is string => typeof id === 'string')
            : [],
          cursor: isPoint(presence.cursor) ? { ...presence.cursor } : null,
        }
      })
      .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId)
  }
  function emitMembers() {
    options.onMembersChange(readMembers())
  }
  function setNickname(value: string) {
    if (!destroyed && value.trim())
      awareness.setLocalStateField('user', { name: value.trim().slice(0, 24) })
  }
  function setEditingNodeId(id: string | null) {
    if (destroyed || (id !== null && !board.readNode(id))) return
    if (awareness.getLocalState()?.editingNodeId !== id)
      awareness.setLocalStateField('editingNodeId', id)
  }
  function setDraggingNodeIds(ids: string[]) {
    if (!destroyed)
      awareness.setLocalStateField(
        'draggingNodeIds',
        ids.filter((id) => board.readNode(id)),
      )
  }
  function setCursor(cursor: Point | null) {
    if (!destroyed) awareness.setLocalStateField('cursor', cursor)
  }
  function deleteElements(nodeIds: string[], edgeIds: string[]) {
    const plan = planDeletion(nodeIds, edgeIds, board.snapshot().edges, readMembers())
    board.deleteElements(plan.nodeIds, plan.edgeIds)
    return plan.editors
  }
  // 撤销新增、重做删除也可能移除节点；有人操作时暂缓历史操作，避免绕过防误删。
  function changeHistory(direction: 'undo' | 'redo') {
    if (
      readMembers().some(
        (member) => !member.isSelf && (member.editingNodeId || member.draggingNodeIds.length),
      )
    )
      return false
    board[direction]()
    return true
  }
  function handleSync(synced: boolean) {
    state.synced = synced
    options.onConnectionChange({ ...state })
    if (synced) options.onGraphChange(board.snapshot())
  }
  function handleStatus(event: { status: ConnectionState['status'] }) {
    state.status = event.status
    if (event.status !== 'connected') {
      state.synced = false
      setCursor(null)
      setDraggingNodeIds([])
    }
    options.onConnectionChange({ ...state })
  }
  function handleConnectionFailure() {
    options.onConnectionFailure?.()
  }
  function handleConnectionClose(event: CloseEvent | null) {
    if (event?.code === 4004) {
      provider.disconnect()
      options.onRoomDeleted?.()
    } else if (event?.code === 1009 || event?.code === 4009) {
      // 保留本地文档供用户查看，停止反复重发同一条超限消息。
      provider.disconnect()
      options.onCapacityExceeded?.(event.code === 1009 ? 'message' : 'document')
    } else handleConnectionFailure()
  }
  awareness.on('change', emitMembers)
  provider.on('status', handleStatus)
  provider.on('sync', handleSync)
  provider.on('connection-error', handleConnectionFailure)
  provider.on('connection-close', handleConnectionClose)
  awareness.setLocalState({
    user: { name: options.nickname },
    editingNodeId: null,
    draggingNodeIds: [],
    cursor: null,
  })
  options.onGraphChange(board.snapshot())
  options.onConnectionChange({ ...state })
  options.onHistoryChange({ canUndo: false, canRedo: false })
  provider.connect()

  return {
    addNode: board.addNode,
    addEdge: board.addEdge,
    updateNodeData: board.updateNodeData,
    updatePositions: board.updatePositions,
    stopCapturing: board.stopCapturing,
    snapshot: board.snapshot,
    setNickname,
    setEditingNodeId,
    setDraggingNodeIds,
    setCursor,
    deleteElements,
    changeHistory,
    disconnect: () => provider.disconnect(),
    destroy() {
      if (destroyed) return
      destroyed = true
      awareness.off('change', emitMembers)
      provider.off('status', handleStatus)
      provider.off('sync', handleSync)
      provider.off('connection-error', handleConnectionFailure)
      provider.off('connection-close', handleConnectionClose)
      awareness.setLocalState(null)
      board.destroy()
      provider.destroy()
      doc.destroy()
    },
  }
}
