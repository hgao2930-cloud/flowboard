import type { SharedEdge } from './document'

interface ActiveEditor {
  name: string
  isSelf: boolean
  editingNodeId: string | null
  draggingNodeIds: string[]
}

/** 只按已知 Awareness 状态防误删；不是权限检查或服务端锁。 */
export function planDeletion(
  nodeIds: string[],
  edgeIds: string[],
  edges: SharedEdge[],
  members: ActiveEditor[],
) {
  const blocked = new Set(
    nodeIds.filter((id) =>
      members.some(
        (member) =>
          !member.isSelf && (member.editingNodeId === id || member.draggingNodeIds.includes(id)),
      ),
    ),
  )
  const allowedEdges = edgeIds.filter((id) => {
    const edge = edges.find((edge) => edge.id === id)
    return edge && !blocked.has(edge.source) && !blocked.has(edge.target)
  })
  const editors = [
    ...new Set(
      members
        .filter(
          (member) =>
            !member.isSelf &&
            ((member.editingNodeId !== null && blocked.has(member.editingNodeId)) ||
              member.draggingNodeIds.some((id) => blocked.has(id))),
        )
        .map((member) => member.name),
    ),
  ]
  return { nodeIds: nodeIds.filter((id) => !blocked.has(id)), edgeIds: allowedEdges, editors }
}
