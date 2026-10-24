import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoom, getRoom, deleteRoom, retryRoomSave, RoomApiError } from '../src/rooms/api.ts'

test('创建使用服务端返回的房间号，查询不隐式创建房间', async (t) => {
  const room = { id: 'server-room', title: '架构图', createdAt: 100 }
  const created = { ...room, managementToken: 'a'.repeat(43) }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    requests.push({ path, options })
    return Response.json(options.method === 'POST' ? created : room)
  })
  assert.deepEqual(await createRoom('架构图'), created)
  assert.equal(requests[0].path, '/api/rooms')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), { title: '架构图' })
  assert.deepEqual(await getRoom('server-room'), room)
  assert.equal(requests[1].path, '/api/rooms/server-room')
  assert.equal(requests[1].options.method, undefined)
})

test('删除凭证只在请求头中发送；404 可区别于网络故障；重试保存失败不假装成功', async (t) => {
  const requests = []
  const fetchMock = t.mock.method(globalThis, 'fetch', async (path, options) => {
    requests.push({ path, options })
    return new Response(null, { status: 204 })
  })
  await deleteRoom('room-a', 'a'.repeat(43))
  assert.equal(requests[0].path, '/api/rooms/room-a')
  assert.equal(requests[0].options.method, 'DELETE')
  assert.equal(requests[0].options.headers['X-Room-Management-Token'], 'a'.repeat(43))
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ message: '房间已删除' }, { status: 404 }),
  )
  await assert.rejects(
    getRoom('room-a'),
    (error) => error instanceof RoomApiError && error.status === 404,
  )
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ message: '数据库不可用' }, { status: 503 }),
  )
  await assert.rejects(retryRoomSave('room-a'), /数据库不可用/)
})

test('容量超限查询与重试保留 too_large 状态，不冒充数据库故障', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: '白板超过容量上限', saveState: 'too_large' }, { status: 413 }),
  )
  for (const request of [getRoom, retryRoomSave]) {
    await assert.rejects(
      request('room-a'),
      (error) =>
        error instanceof RoomApiError && error.status === 413 && error.saveState === 'too_large',
    )
  }
})

test('创建响应缺少凭证时明确报错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'a', title: '白板' }))
  await assert.rejects(createRoom('白板'), /缺少管理凭证/)
})

test('数据库查询失败仍保留服务端已知的保存失败状态', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: '数据库不可用', saveState: 'error' }, { status: 503 }),
  )
  await assert.rejects(
    getRoom('a'),
    (error) => error instanceof RoomApiError && error.saveState === 'error',
  )
})

test('不存在、服务离线和无效响应以错误结束，不返回可进入的房间', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: '房间不存在' }, { status: 404 }),
  )
  await assert.rejects(getRoom('missing'), /房间不存在/)
  fetchMock.mock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch')
  })
  await assert.rejects(getRoom('missing'), /无法连接房间服务/)
  fetchMock.mock.mockImplementation(async () => new Response('ok'))
  await assert.rejects(getRoom('missing'), /数据不完整/)
})
