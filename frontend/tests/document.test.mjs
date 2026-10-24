import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createBoardDocument } from '../src/collaboration/document.ts'

function client(t) {
  const doc = new Y.Doc()
  let graph = { nodes: [], edges: [] }
  let history = { canUndo: false, canRedo: false }
  const board = createBoardDocument(
    doc,
    (value) => {
      graph = value
    },
    (value) => {
      history = value
    },
  )
  t.after(() => {
    board.destroy()
    doc.destroy()
  })
  return {
    doc,
    board,
    get graph() {
      return graph
    },
    get history() {
      return history
    },
  }
}
function node(id) {
  return { id, position: { x: 0, y: 0 }, data: { label: id, content: '', color: 'mint' } }
}
function exchange(a, b) {
  const aUpdate = Y.encodeStateAsUpdate(a.doc)
  const bUpdate = Y.encodeStateAsUpdate(b.doc)
  Y.applyUpdate(a.doc, bUpdate)
  Y.applyUpdate(b.doc, aUpdate)
}

test('输入立即投影，空标题与空格不会被每次输入校验截断', (t) => {
  const a = client(t)
  a.board.addNode(node('a'))
  a.board.updateNodeData('a', { label: '' })
  assert.equal(a.graph.nodes[0].data.label, '')
  a.board.updateNodeData('a', { label: 'hello ' })
  assert.equal(a.graph.nodes[0].data.label, 'hello ')
  a.board.updateNodeData('a', { content: '第一行\n第二行' })
  assert.equal(a.graph.nodes[0].data.content, '第一行\n第二行')
})

test('断开交换期间分别编辑标题和正文，合并后两项都保留', (t) => {
  const a = client(t),
    b = client(t)
  a.board.addNode(node('a'))
  exchange(a, b)
  a.board.updateNodeData('a', { label: '新标题' })
  b.board.updateNodeData('a', { content: '远端正文', color: 'blue' })
  exchange(a, b)
  assert.deepEqual(a.board.snapshot(), b.board.snapshot())
  assert.deepEqual(a.graph.nodes[0].data, { label: '新标题', content: '远端正文', color: 'blue' })
})

test('同字段并发最终一致；重复应用更新不重复修改', (t) => {
  const a = client(t),
    b = client(t)
  a.board.addNode(node('a'))
  exchange(a, b)
  a.board.updateNodeData('a', { label: 'A 标题' })
  b.board.updateNodeData('a', { label: 'B 标题' })
  exchange(a, b)
  const expected = a.board.snapshot()
  assert.deepEqual(expected, b.board.snapshot())
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
  assert.deepEqual(a.board.snapshot(), expected)
})

test('旧普通对象节点的并发首次编辑无需竞争迁移 Map', (t) => {
  const a = client(t),
    b = client(t)
  const legacy = new Y.Map()
  legacy.set('position', { x: 20, y: 30 })
  legacy.set('data', { label: '旧节点' })
  a.doc.getMap('nodes').set('old', legacy)
  exchange(a, b)
  a.board.updateNodeData('old', { label: '新标题' })
  b.board.updateNodeData('old', { content: '新正文' })
  exchange(a, b)
  assert.deepEqual(a.board.readNode('old').data, {
    label: '新标题',
    content: '新正文',
    color: 'mint',
  })
  assert.deepEqual(a.board.snapshot(), b.board.snapshot())
})

test('删除节点与关联边只有一个文档更新，撤销可以一起恢复', (t) => {
  const a = client(t)
  for (const id of ['a', 'b', 'c']) a.board.addNode(node(id))
  a.board.addEdge({ id: 'in', source: 'b', target: 'a' })
  a.board.addEdge({ id: 'out', source: 'a', target: 'c' })
  a.board.addEdge({ id: 'keep', source: 'b', target: 'c' })
  let updates = 0
  a.doc.on('update', () => updates++)
  a.board.deleteElements(['a'], [])
  assert.equal(updates, 1)
  assert.deepEqual(
    a.graph.edges.map((edge) => edge.id),
    ['keep'],
  )
  a.board.undo()
  assert.equal(a.graph.nodes.length, 3)
  assert.equal(a.graph.edges.length, 3)
  a.board.redo()
  assert.equal(a.graph.nodes.length, 2)
  assert.equal(a.graph.edges.length, 1)
})

test('拖动过程实时投影，一次拖动只需一次撤销；不撤销远端正文', (t) => {
  const a = client(t),
    b = client(t)
  a.board.addNode(node('a'))
  exchange(a, b)
  a.board.stopCapturing()
  a.board.updatePositions([{ id: 'a', position: { x: 12, y: 24 } }])
  assert.deepEqual(a.graph.nodes[0].position, { x: 12, y: 24 })
  a.board.updatePositions([{ id: 'a', position: { x: 240, y: 360 } }])
  a.board.stopCapturing()
  b.board.updateNodeData('a', { content: '其他人的修改' })
  exchange(a, b)
  a.board.undo()
  assert.deepEqual(a.graph.nodes[0].position, { x: 0, y: 0 })
  assert.equal(a.graph.nodes[0].data.content, '其他人的修改')
  assert.equal(a.history.canRedo, true)
})

test('删除与编辑/新增连线并发时不复活节点，也不渲染悬空边', (t) => {
  const a = client(t),
    b = client(t)
  a.board.addNode(node('a'))
  a.board.addNode(node('b'))
  exchange(a, b)
  a.board.deleteElements(['a'], [])
  b.board.updateNodeData('a', { label: '迟到的编辑' })
  b.board.addEdge({ id: 'late', source: 'a', target: 'b' })
  exchange(a, b)
  assert.deepEqual(a.board.snapshot(), b.board.snapshot())
  assert.equal(a.board.readNode('a'), null)
  assert.equal(a.graph.edges.length, 0)
  assert.equal(a.board.updateNodeData('a', { content: '迟到的失焦' }), false)
})

test('拒绝自连接和重复连接；同时新增的重复连接可统一删除', (t) => {
  const a = client(t),
    b = client(t)
  a.board.addNode(node('a'))
  a.board.addNode(node('b'))
  exchange(a, b)
  assert.ok(a.board.addEdge({ id: 'self', source: 'a', target: 'a' }))
  assert.equal(a.board.addEdge({ id: 'edge-1', source: 'a', target: 'b' }), null)
  assert.ok(a.board.addEdge({ id: 'duplicate', source: 'a', target: 'b' }))
  b.board.addEdge({ id: 'edge-2', source: 'a', target: 'b' })
  exchange(a, b)
  assert.equal(a.graph.edges.length, 1)
  assert.deepEqual(a.graph.edges, b.graph.edges)
  a.board.deleteElements([], [a.graph.edges[0].id])
  exchange(a, b)
  assert.equal(a.graph.edges.length, 0)
  assert.equal(b.graph.edges.length, 0)
})

test('销毁后不再回调或写入文档', (t) => {
  const a = client(t)
  a.board.addNode(node('a'))
  const before = a.graph
  a.board.destroy()
  a.doc.getMap('nodes').delete('a')
  assert.equal(a.graph, before)
  assert.equal(a.board.addNode(node('b')), false)
  assert.equal(a.board.updateNodeData('a', { label: '不应写入' }), false)
})
