import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { WebSocketServer } from '../../backend/node_modules/ws/wrapper.mjs'

test('真实 provider 收到容量关闭码后停止重连，保留本地卡片', { timeout: 15000 }, async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  let code = 1009
  let connections = 0
  wss.on('connection', (ws) => {
    connections++
    ws.close(code)
  })
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    define: {
      'import.meta.env.VITE_WS_URL': JSON.stringify(`ws://127.0.0.1:${wss.address().port}`),
    },
  })
  const previousLocation = globalThis.location
  globalThis.location = { protocol: 'http:', hostname: '127.0.0.1' }
  t.after(async () => {
    if (previousLocation === undefined) delete globalThis.location
    else globalThis.location = previousLocation
    await vite.close()
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
  })
  const { default: createSession } = await vite.ssrLoadModule('/src/collaboration/session.ts')
  for (const [closeCode, expected] of [
    [1009, 'message'],
    [4009, 'document'],
  ]) {
    await t.test(String(closeCode), async () => {
      code = closeCode
      connections = 0
      let session
      let notify
      const received = new Promise((resolve) => {
        notify = resolve
      })
      try {
        session = createSession({
          roomId: 'capacity-test',
          nickname: '测试',
          onGraphChange() {},
          onMembersChange() {},
          onConnectionChange() {},
          onHistoryChange() {},
          onCapacityExceeded: notify,
        })
        session.addNode({
          id: 'local',
          position: { x: 0, y: 0 },
          data: { label: '未保存内容', content: '保留这段文字', color: 'mint' },
        })
        assert.equal(await received, expected)
        await new Promise((resolve) => setTimeout(resolve, 700))
        assert.equal(connections, 1)
        assert.equal(session.snapshot().nodes[0].data.content, '保留这段文字')
      } finally {
        session?.destroy()
      }
    })
  }
})
