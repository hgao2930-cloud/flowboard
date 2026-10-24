import test from 'node:test'
import assert from 'node:assert/strict'
import { planDeletion } from '../src/collaboration/deletion.ts'

const edges = [
  { id: 'ab', source: 'a', target: 'b' },
  { id: 'bc', source: 'b', target: 'c' },
]
const editor = { name: '访客', isSelf: false, editingNodeId: 'a', draggingNodeIds: [] }

test('批量删除被部分阻止时，保留被保护节点及选中的关联边', () => {
  const plan = planDeletion(['a', 'c'], ['ab', 'bc'], edges, [editor])
  assert.deepEqual(plan, { nodeIds: ['c'], edgeIds: ['bc'], editors: ['访客'] })
})
test('自己的编辑状态不阻止删除，昵称相同的其他客户端仍然阻止', () => {
  const self = { ...editor, isSelf: true }
  assert.deepEqual(planDeletion(['a'], [], edges, [self]).nodeIds, ['a'])
  assert.deepEqual(planDeletion(['a'], [], edges, [self, editor]).nodeIds, [])
})
test('拖动提示也保护节点，成员离线移除后可重新删除', () => {
  const moving = { ...editor, editingNodeId: null, draggingNodeIds: ['a'] }
  assert.deepEqual(planDeletion(['a'], [], edges, [moving]).nodeIds, [])
  assert.deepEqual(planDeletion(['a'], [], edges, []).nodeIds, ['a'])
})
