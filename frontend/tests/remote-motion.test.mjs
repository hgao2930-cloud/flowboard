import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteMotion } from '../src/collaboration/remoteMotion.ts'

function harness() {
  let now = 0
  let sequence = 0
  const callbacks = new Map()
  let positions = new Map()
  const motion = createRemoteMotion(
    (value) => {
      positions = value
    },
    {
      now: () => now,
      request: (callback) => {
        callbacks.set(++sequence, callback)
        return sequence
      },
      cancel: (id) => callbacks.delete(id),
    },
  )
  return {
    motion,
    get positions() {
      return positions
    },
    get pending() {
      return callbacks.size
    },
    step(time) {
      now = time
      const current = [...callbacks.values()]
      callbacks.clear()
      for (const callback of current) callback(now)
    },
  }
}

test('远端位置按帧过渡，到达精确终点后停止调度', () => {
  const h = harness()
  const target = { x: 140, y: 70 }
  h.motion.move('a', { x: 0, y: 0 }, target)
  target.x = 999
  h.step(35)
  assert.deepEqual(h.positions.get('a'), { x: 70, y: 35 })
  h.step(70)
  assert.deepEqual(h.positions.get('a'), { x: 140, y: 70 })
  assert.equal(h.pending, 0)
})

test('收到更新从当前显示位置转向；重复目标不延长动画，也不创建多个帧循环', () => {
  const h = harness()
  h.motion.move('a', { x: 0, y: 0 }, { x: 100, y: 0 })
  h.step(35)
  h.motion.move('a', h.positions.get('a'), { x: 200, y: 0 })
  h.motion.move('a', h.positions.get('a'), { x: 200, y: 0 })
  assert.equal(h.pending, 1)
  h.step(70)
  assert.deepEqual(h.positions.get('a'), { x: 125, y: 0 })
  h.motion.move('a', h.positions.get('a'), { x: 200, y: 0 })
  h.step(105)
  assert.deepEqual(h.positions.get('a'), { x: 200, y: 0 })
  assert.equal(h.pending, 0)
})

test('本地接管、删除和卸载能取消动画；后台停顿后下一帧直接追上', () => {
  const h = harness()
  h.motion.move('a', { x: 0, y: 0 }, { x: 100, y: 0 })
  h.motion.remove('a')
  assert.equal(h.pending, 0)
  h.motion.move('b', { x: 0, y: 0 }, { x: 100, y: 0 })
  h.motion.retain(new Set())
  assert.equal(h.pending, 0)
  h.motion.move('c', { x: 0, y: 0 }, { x: 100, y: 0 })
  h.step(5000)
  assert.deepEqual(h.positions.get('c'), { x: 100, y: 0 })
  assert.equal(h.pending, 0)
  h.motion.move('c', { x: 100, y: 0 }, { x: 200, y: 0 })
  h.motion.clear()
  assert.equal(h.pending, 0)
})
