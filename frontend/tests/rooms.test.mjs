import test from 'node:test'
import assert from 'node:assert/strict'
import { isRoomId, parseRoomInput, roomIdFromPath } from '../src/rooms/roomId.ts'
import {
  organizeRecentBoards,
  readRecentBoards,
  recordBoardVisit,
  removeRecentBoard,
  RECENT_BOARDS_KEY,
} from '../src/rooms/recentBoards.ts'

const origin = 'https://flowboard.example'
test('子路径部署的邀请链接保留应用前缀，拒绝其他应用和折叠路径', () => {
  assert.deepEqual(
    parseRoomInput(`${origin}/flowboard/board/demo-a?from=friend`, origin, '/flowboard/'),
    { roomId: 'demo-a' },
  )
  assert.deepEqual(parseRoomInput('demo-a', origin, '/flowboard/'), { roomId: 'demo-a' })
  for (const path of [
    '/board/demo-a',
    '/flowboard-other/board/demo-a',
    '/flowboard/../flowboard/board/demo-a',
    '/flowboard/board/demo-a/extra',
  ]) {
    assert.equal(typeof parseRoomInput(`${origin}${path}`, origin, '/flowboard/').error, 'string')
  }
})
function memoryStorage(initial = null) {
  let raw = initial
  return {
    getItem(key) {
      assert.equal(key, RECENT_BOARDS_KEY)
      return raw
    },
    setItem(key, value) {
      assert.equal(key, RECENT_BOARDS_KEY)
      raw = value
    },
  }
}

test('房间号保留大小写，兼容演示房间和 UUID；限制字符与长度', () => {
  for (const roomId of [
    'demo-a',
    'demo-b',
    'AbC_123-',
    'a'.repeat(64),
    '550e8400-e29b-41d4-a716-446655440000',
  ]) {
    assert.equal(isRoomId(roomId), true)
    assert.deepEqual(parseRoomInput(` ${roomId} `, origin), { roomId })
  }
  for (const roomId of ['', 'a'.repeat(65), 'a/b', 'a b', '中文', 'a%20b', 'a\nb']) {
    assert.equal(isRoomId(roomId), false)
    assert.equal(typeof parseRoomInput(roomId, origin).error, 'string')
  }
  for (const roomId of ['a\n', 'a\r', 'a\u2028', 'a'.repeat(64) + '\n']) {
    assert.equal(isRoomId(roomId), false)
  }
})

test('本站完整链接仅提取房间号，忽略查询参数和 hash，支持单个尾斜杠和合法编码', () => {
  for (const path of ['/board/AbC_123', '/board/AbC_123/', '/board/%41bC_123']) {
    assert.deepEqual(parseRoomInput(`${origin}${path}?from=friend#details`, origin), {
      roomId: 'AbC_123',
    })
    assert.equal(roomIdFromPath(path), 'AbC_123')
  }
  assert.deepEqual(parseRoomInput('http://localhost:5173/board/demo-a', 'http://localhost:5173'), {
    roomId: 'demo-a',
  })
})

test('拒绝外站、其他协议、其他路径、额外路径段和非法编码', () => {
  for (const value of [
    'https://another.example/board/demo-a',
    'http://flowboard.example/board/demo-a',
    'ftp://flowboard.example/board/demo-a',
    'javascript:alert(1)',
    '//flowboard.example/board/demo-a',
    '/board/demo-a',
    `${origin}/`,
    `${origin}/boards/demo-a`,
    `${origin}/board/`,
    `${origin}/board/demo-a/extra`,
    `${origin}/board/demo-a//`,
    `${origin}/board/a/../demo-a`,
    `${origin}/board/%2e%2e/board/demo-a`,
    `${origin}/board/a%2Fb`,
    `${origin}/board/a%252Fb`,
    `${origin}/board/demo-a%0A`,
    `${origin}/board/demo-a%0D`,
    `${origin}/board/%ZZ`,
    `${origin}/board/%E0%A4%A`,
    `${origin}/board/${'a'.repeat(65)}`,
  ])
    assert.equal(typeof parseRoomInput(value, origin).error, 'string', value)
  for (const path of [
    '/board',
    '/board/',
    '/board/a/b',
    '/board/a//',
    '/board/%ZZ',
    '/board/a%2Fb',
    '/board/a/\n',
    '/board/a%0A',
  ]) {
    assert.equal(roomIdFromPath(path), null, path)
  }
})

test('损坏 JSON、错误根类型和坏条目不会影响正常记录读取', () => {
  for (const raw of ['{broken', 'null', '{}', '"hello"']) {
    assert.deepEqual(readRecentBoards(memoryStorage(raw)), {
      boards: [],
      storageUnavailable: false,
    })
  }
  const raw = JSON.stringify([
    null,
    [],
    1,
    { roomId: 'valid', localName: '  本机名称  ', lastVisitedAt: 100, extra: '不保留' },
    { roomId: 'no-name', lastVisitedAt: 90 },
    { roomId: 'blank-name', localName: '  ', lastVisitedAt: 80 },
    { roomId: 'a/b', lastVisitedAt: 1 },
    { roomId: 'long-name', localName: '名'.repeat(41), lastVisitedAt: 1 },
    { roomId: 'bad-name', localName: 42, lastVisitedAt: 1 },
    { roomId: 'bad-time', lastVisitedAt: '100' },
    { roomId: 'negative-time', lastVisitedAt: -1 },
    { roomId: 'fractional-time', lastVisitedAt: 1.5 },
    { roomId: 'huge-time', lastVisitedAt: 8.64e15 + 1 },
  ])
  assert.deepEqual(readRecentBoards(memoryStorage(raw)).boards, [
    { roomId: 'valid', localName: '本机名称', lastVisitedAt: 100 },
    { roomId: 'no-name', lastVisitedAt: 90 },
    { roomId: 'blank-name', lastVisitedAt: 80 },
  ])
  assert.deepEqual(organizeRecentBoards([{ roomId: 'infinity', lastVisitedAt: Infinity }]), [])
})

test('记录按房间去重、降序排序、最多 20 条，重访保留名称并更新访问时间', () => {
  const records = Array.from({ length: 25 }, (_, index) => ({
    roomId: `room-${index}`,
    lastVisitedAt: index,
  }))
  records.push({ roomId: 'room-24', localName: '较早的名称', lastVisitedAt: 1 })
  const boards = organizeRecentBoards(records)
  assert.equal(boards.length, 20)
  assert.deepEqual(boards[0], { roomId: 'room-24', localName: '较早的名称', lastVisitedAt: 24 })
  assert.equal(boards.at(-1).roomId, 'room-5')
  const storage = memoryStorage(JSON.stringify(boards))
  const result = recordBoardVisit('room-24', '不应覆盖已有名称', storage, 100)
  assert.equal(result.boards.length, 20)
  assert.deepEqual(result.boards[0], {
    roomId: 'room-24',
    localName: '较早的名称',
    lastVisitedAt: 100,
  })
  recordBoardVisit('new-room', undefined, storage, 101)
  assert.deepEqual(readRecentBoards(storage).boards[0], { roomId: 'new-room', lastVisitedAt: 101 })
  assert.equal(readRecentBoards(storage).boards.length, 20)
})

test('记录访问时保存名称，移除仅改本机记录', () => {
  const storage = memoryStorage()
  assert.deepEqual(readRecentBoards(storage).boards, [])
  recordBoardVisit('new-room', '白板名称', storage, 100)
  recordBoardVisit('another-room', '白板名称', storage, 101)
  assert.equal(readRecentBoards(storage).boards.length, 2)
  assert.deepEqual(removeRecentBoard('new-room', storage).boards, [
    { roomId: 'another-room', localName: '白板名称', lastVisitedAt: 101 },
  ])
  assert.equal(readRecentBoards(storage).boards.length, 1)
})

test('拒绝读写存储时返回提示状态，不抛异常；读取失败不覆盖未知的原记录', () => {
  let writes = 0
  const blockedRead = {
    getItem() {
      throw new Error('Storage denied')
    },
    setItem() {
      writes++
    },
  }
  assert.equal(readRecentBoards(blockedRead).storageUnavailable, true)
  assert.equal(recordBoardVisit('demo-a', undefined, blockedRead).storageUnavailable, true)
  assert.equal(removeRecentBoard('demo-a', blockedRead).storageUnavailable, true)
  assert.equal(writes, 0)
  const blockedWrite = {
    getItem() {
      return null
    },
    setItem() {
      throw new Error('Quota exceeded')
    },
  }
  assert.equal(recordBoardVisit('demo-a', undefined, blockedWrite).storageUnavailable, true)
  assert.equal(removeRecentBoard('demo-a', blockedWrite).storageUnavailable, true)
})
