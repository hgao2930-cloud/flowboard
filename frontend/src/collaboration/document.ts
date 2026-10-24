import * as Y from 'yjs'

export const nodeColors = ['mint', 'blue', 'violet', 'amber', 'rose'] as const
export type NodeColor = (typeof nodeColors)[number]
export interface Point {
  x: number
  y: number
}
export interface SharedNode {
  id: string
  position: Point
  data: { label: string; content: string; color: NodeColor }
}
export type NodeDataPatch = Partial<SharedNode['data']>
export interface SharedEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}
export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}
export interface GraphSnapshot {
  nodes: SharedNode[]
  edges: SharedEdge[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function isPoint(value: unknown): value is Point {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  )
}
function isColor(value: unknown): value is NodeColor {
  return nodeColors.includes(value as NodeColor)
}

/** 共享图的唯一写入入口；不依赖 Vue 或网络，方便独立验证并发规则。 */
export function createBoardDocument(
  doc: Y.Doc,
  onChange: (graph: GraphSnapshot, local: boolean) => void,
  onHistory: (state: HistoryState) => void,
) {
  const yNodes = doc.getMap<Y.Map<unknown>>('nodes')
  const yEdges = doc.getMap<SharedEdge>('edges')
  const localOrigin = Symbol('board-local')
  const undoManager = new Y.UndoManager([yNodes, yEdges], {
    trackedOrigins: new Set([localOrigin]),
    captureTimeout: Infinity,
  })
  let currentGroup: string | null = null
  let destroyed = false

  function readNode(id: string): SharedNode | null {
    const node = yNodes.get(id)
    if (!(node instanceof Y.Map)) return null
    const position = node.get('position')
    const data = node.get('data')
    if (!isPoint(position)) return null
    // 老节点的 data 是普通对象。字段覆盖写在已有 yNode 上，不竞争创建新的嵌套 Map。
    const read = (key: string): unknown =>
      data instanceof Y.Map
        ? data.get(key)
        : node.has(key)
          ? node.get(key)
          : isRecord(data)
            ? data[key]
            : undefined
    const label = read('label')
    if (typeof label !== 'string') return null
    const content = read('content')
    const color = read('color')
    return {
      id,
      position: { ...position },
      data: {
        label,
        content: typeof content === 'string' ? content : '',
        color: isColor(color) ? color : 'mint',
      },
    }
  }

  function snapshot(): GraphSnapshot {
    const nodes = [...yNodes.keys()].flatMap((id) => {
      const node = readNode(id)
      return node ? [node] : []
    })
    const ids = new Set(nodes.map((node) => node.id))
    const seen = new Set<string>()
    const edges: SharedEdge[] = []
    // 同时添加相同连线时，两端选择同一个稳定 ID 的记录用于显示，不在观察器回写。
    for (const [id, edge] of [...yEdges.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (
        !isRecord(edge) ||
        typeof edge.source !== 'string' ||
        typeof edge.target !== 'string' ||
        !ids.has(edge.source) ||
        !ids.has(edge.target) ||
        edge.source === edge.target
      )
        continue
      const sourceHandle = typeof edge.sourceHandle === 'string' ? edge.sourceHandle : null
      const targetHandle = typeof edge.targetHandle === 'string' ? edge.targetHandle : null
      const signature = JSON.stringify([edge.source, sourceHandle, edge.target, targetHandle])
      if (seen.has(signature)) continue
      seen.add(signature)
      edges.push({ id, source: edge.source, target: edge.target, sourceHandle, targetHandle })
    }
    return { nodes, edges }
  }

  function emitHistory() {
    onHistory({ canUndo: undoManager.canUndo(), canRedo: undoManager.canRedo() })
  }
  function stopCapturing() {
    currentGroup = null
    undoManager.stopCapturing()
  }
  function mutate(group: string | null, action: () => void) {
    if (destroyed) return
    if (group === null || currentGroup !== group) undoManager.stopCapturing()
    currentGroup = group
    doc.transact(action, localOrigin)
    if (group === null) stopCapturing()
  }
  function addNode(node: SharedNode) {
    if (destroyed || yNodes.has(node.id) || !isPoint(node.position)) return false
    mutate(null, () => {
      const yNode = new Y.Map<unknown>()
      const data = new Y.Map<unknown>()
      data.set('label', node.data.label)
      data.set('content', node.data.content)
      data.set('color', isColor(node.data.color) ? node.data.color : 'mint')
      yNode.set('position', { ...node.position })
      yNode.set('data', data)
      yNodes.set(node.id, yNode)
    })
    return true
  }
  function updateNodeData(id: string, patch: NodeDataPatch) {
    if (destroyed) return false
    const node = yNodes.get(id)
    const current = readNode(id)
    if (!(node instanceof Y.Map) || !current) return false
    const entries = Object.entries(patch).filter(
      ([key, value]) =>
        (key === 'label' || key === 'content' || key === 'color') &&
        typeof value === 'string' &&
        (key !== 'color' || isColor(value)) &&
        current.data[key as keyof NodeDataPatch] !== value,
    )
    if (!entries.length) return true
    mutate(`text:${id}:${entries.map(([key]) => key).join(',')}`, () => {
      const data = node.get('data')
      const target: Y.Map<unknown> = data instanceof Y.Map ? data : node
      for (const [key, value] of entries) target.set(key, value)
    })
    return true
  }
  function updatePositions(positions: { id: string; position: Point }[]) {
    mutate('drag', () => {
      for (const { id, position } of positions) {
        const node = yNodes.get(id)
        if (!(node instanceof Y.Map) || !isPoint(position)) continue
        const old = node.get('position')
        if (!isPoint(old) || old.x !== position.x || old.y !== position.y)
          node.set('position', { ...position })
      }
    })
  }
  function addEdge(edge: SharedEdge): string | null {
    if (destroyed || !readNode(edge.source) || !readNode(edge.target)) return '连接的节点已不存在。'
    if (edge.source === edge.target) return '请连接两个不同的节点。'
    const duplicate = snapshot().edges.some(
      (item) =>
        item.source === edge.source &&
        item.target === edge.target &&
        (item.sourceHandle ?? null) === (edge.sourceHandle ?? null) &&
        (item.targetHandle ?? null) === (edge.targetHandle ?? null),
    )
    if (duplicate) return '这两个端点之间已经有连线了。'
    mutate(null, () =>
      yEdges.set(edge.id, {
        ...edge,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      }),
    )
    return null
  }
  function deleteElements(nodeIds: string[], edgeIds: string[]) {
    const ids = new Set(nodeIds)
    const selectedEdges = new Set(edgeIds)
    // 删除视觉上的重复边时，一并删除相同端点的隐藏记录，避免另一条突然出现。
    const signatures = new Set(
      [...selectedEdges].flatMap((id) => {
        const edge = yEdges.get(id)
        return edge
          ? [
              JSON.stringify([
                edge.source,
                edge.sourceHandle ?? null,
                edge.target,
                edge.targetHandle ?? null,
              ]),
            ]
          : []
      }),
    )
    mutate(null, () => {
      for (const id of ids) yNodes.delete(id)
      for (const [id, edge] of yEdges) {
        if (
          ids.has(edge.source) ||
          ids.has(edge.target) ||
          signatures.has(
            JSON.stringify([
              edge.source,
              edge.sourceHandle ?? null,
              edge.target,
              edge.targetHandle ?? null,
            ]),
          )
        )
          yEdges.delete(id)
      }
    })
  }
  function afterTransaction(transaction: Y.Transaction) {
    const changed: ReadonlyMap<unknown, unknown> = transaction.changedParentTypes
    if (changed.has(yNodes) || changed.has(yEdges))
      onChange(snapshot(), transaction.origin === localOrigin || transaction.origin === undoManager)
  }
  doc.on('afterTransaction', afterTransaction)
  undoManager.on('stack-item-added', emitHistory)
  undoManager.on('stack-item-popped', emitHistory)
  undoManager.on('stack-item-updated', emitHistory)
  undoManager.on('stack-cleared', emitHistory)

  return {
    snapshot,
    readNode,
    addNode,
    addEdge,
    updateNodeData,
    updatePositions,
    deleteElements,
    stopCapturing,
    undo() {
      if (!destroyed) {
        stopCapturing()
        undoManager.undo()
      }
    },
    redo() {
      if (!destroyed) {
        stopCapturing()
        undoManager.redo()
      }
    },
    destroy() {
      destroyed = true
      doc.off('afterTransaction', afterTransaction)
      undoManager.destroy()
    },
  }
}
