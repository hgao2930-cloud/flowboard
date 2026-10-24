import test from 'node:test'
import assert from 'node:assert/strict'
import {
  saveManagementToken,
  readManagementToken,
  removeManagementToken,
  isManagementTokenTemporary,
} from '../src/rooms/management.ts'
import { removeRecentBoard, RECENT_BOARDS_KEY } from '../src/rooms/recentBoards.ts'

test('凭证独立于最近访问；移除历史不移除管理权，成功删除可清理凭证', () => {
  const data = new Map()
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  }
  const id = 'credential-test'
  const token = 'a'.repeat(43)
  assert.equal(saveManagementToken(id, token, storage), true)
  storage.setItem(RECENT_BOARDS_KEY, JSON.stringify([{ roomId: id, lastVisitedAt: 100 }]))
  removeRecentBoard(id, storage)
  assert.equal(readManagementToken(id, storage), token)
  assert.equal(JSON.parse(storage.getItem(RECENT_BOARDS_KEY)).length, 0)
  assert.equal(removeManagementToken(id, storage), true)
  assert.equal(readManagementToken(id, storage), null)
})

test('存储拒绝时保留当前页面的管理能力并标记警告，不接受损坏凭证', () => {
  const blocked = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
    removeItem() {
      throw new Error('denied')
    },
  }
  const id = 'temporary-credential'
  const token = 'b'.repeat(43)
  assert.equal(saveManagementToken(id, token, blocked), false)
  assert.equal(isManagementTokenTemporary(id), true)
  assert.equal(readManagementToken(id, blocked), token)
  assert.equal(removeManagementToken(id, blocked), false)
  assert.equal(readManagementToken(id, blocked), null)
  assert.equal(readManagementToken('unknown', { getItem: () => 'bad' }), null)
})
