import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import { createApp } from "../src/server.js";
import { readLimits } from "../src/room-runtime.js";
import { testStore, until, deferred } from "./helpers.mjs";

// 真实 HTTP/WebSocket + 测试存储。MySQL 持久化由 mysql.test.mjs 单独验证。
test(
  "房间权限、HTTP、WebSocket 升级、同步与删除",
  { timeout: 15000 },
  async (t) => {
    const store = testStore();
    const limits = {
      ...readLimits(),
      maxRooms: 5,
      maxConnections: 3,
      saveInterval: 30,
    };
    const app = await createApp({
      store,
      limits,
    });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const port = app.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const clients = [];
    t.after(async () => {
      for (const ws of clients) ws.terminate();
      await app.close();
    });
    const post = (body, headers = { "Content-Type": "application/json" }) =>
      fetch(`${base}/api/rooms`, { method: "POST", headers, body });
    const query = (id) => fetch(`${base}/api/rooms/${id}`);
    const remove = (id, token) =>
      fetch(`${base}/api/rooms/${id}`, {
        method: "DELETE",
        headers: token ? { "X-Room-Management-Token": token } : {},
      });
    function socket(id) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/${id}`);
      ws.on("error", () => {});
      clients.push(ws);
      return ws;
    }
    async function rejectUpgrade(id, status) {
      const ws = socket(id);
      const [req, res] = await once(ws, "unexpected-response");
      assert.equal(res.statusCode, status);
      res.resume();
      req.destroy();
    }
    async function syncClient(id, existingDoc) {
      const ws = socket(id);
      const doc = existingDoc ?? new Y.Doc();
      if (!existingDoc) t.after(() => doc.destroy());
      let synced = false;
      ws.on("message", (data) => {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) !== 0) return;
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        const type = sync.readSyncMessage(decoder, reply, doc, ws);
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
        if (type === 1) synced = true;
      });
      const publish = (update, origin) => {
        if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
        const message = encoding.createEncoder();
        encoding.writeVarUint(message, 0);
        sync.writeUpdate(message, update);
        ws.send(encoding.toUint8Array(message));
      };
      doc.on("update", publish);
      ws.once("close", () => doc.off("update", publish));
      await once(ws, "open");
      const request = encoding.createEncoder();
      encoding.writeVarUint(request, 0);
      sync.writeSyncStep1(request, doc);
      ws.send(encoding.toUint8Array(request));
      await until(() => synced);
      return { ws, doc };
    }
    let room;
    await t.test(
      "创建落存储才返回凭证；查询不泄露凭证或哈希，不隐式建房",
      async () => {
        assert.equal((await query("demo-a")).status, 404);
        assert.equal((await query("unknown")).status, 404);
        const response = await post(
          JSON.stringify({ title: "  项目白板  ", owner: "fake", id: "fake" }),
        );
        assert.equal(response.status, 201);
        room = await response.json();
        assert.equal(room.title, "项目白板");
        assert.equal(room.managementToken.length, 43);
        assert.notEqual(room.id, "fake");
        assert.equal(store.rows.has(room.id), true);
        assert.notEqual(
          store.rows.get(room.id).managementHash.toString(),
          room.managementToken,
        );
        const publicData = await (await query(room.id)).json();
        assert.equal(publicData.id, room.id);
        assert.equal(publicData.managementToken, undefined);
        assert.equal(publicData.managementHash, undefined);
        assert.equal(publicData.owner, undefined);
        const original = store.create;
        store.create = async () => {
          throw new Error("database offline");
        };
        assert.equal(
          (await post(JSON.stringify({ title: "不应创建成功" }))).status,
          503,
        );
        store.create = original;
      },
    );
    await t.test("无效名称、JSON、请求方法与请求大小被拒绝", async () => {
      for (const body of [
        { title: "" },
        { title: "  " },
        { title: "字".repeat(41) },
        { title: 1 },
        null,
      ]) {
        assert.equal((await post(JSON.stringify(body))).status, 400);
      }
      assert.equal((await post("{broken")).status, 400);
      assert.equal((await post("x".repeat(5000))).status, 413);
      assert.equal(
        (await post("text", { "Content-Type": "text/plain" })).status,
        415,
      );
      assert.equal((await fetch(`${base}/api/rooms`)).status, 405);
    });
    await t.test(
      "缺少、错误凭证不能删除，不信任 owner；正确凭证可删除",
      async () => {
        assert.equal((await remove(room.id)).status, 401);
        assert.equal((await remove(room.id, "b".repeat(43))).status, 403);
        assert.equal((await query(room.id)).status, 200);
      },
    );
    await t.test(
      "未知、额外路径及非法编码不能升级；异常断开不令进程退出",
      async () => {
        for (const id of ["unknown", "demo-a/extra", "", "a%2Fb"])
          await rejectUpgrade(id, 404);
        await new Promise((resolve) => {
          const raw = createConnection({ port, host: "127.0.0.1" });
          raw.on("error", () => {});
          raw.once("close", resolve);
          raw.once("connect", () => {
            raw.write(
              "GET /unknown HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
              () => raw.destroy(),
            );
          });
        });
        assert.equal((await query(room.id)).status, 200);
      },
    );
    await t.test("加载完成前不握手，失败拒绝升级而非发送空文档", async () => {
      const gate = deferred();
      store.beforeLoad = () => gate.promise;
      const ws = socket(room.id);
      let opened = false;
      ws.on("open", () => {
        opened = true;
      });
      await until(() => app.runtime.entries.size === 1);
      assert.equal(opened, false);
      gate.resolve();
      await once(ws, "open");
      ws.close();
      await once(ws, "close");
      await until(() => app.runtime.entries.size === 0);
      store.beforeLoad = () => {
        throw new Error("offline");
      };
      await rejectUpgrade(room.id, 503);
      store.beforeLoad = null;
    });
    await t.test(
      "双端同步、保存释放后新客户端仍读到状态；连接与消息上限生效",
      async () => {
        const a = await syncClient(room.id);
        const b = await syncClient(room.id);
        a.doc.getMap("test").set("title", "同步验证");
        await until(() => b.doc.getMap("test").get("title") === "同步验证");
        const c = await syncClient(room.id);
        await rejectUpgrade(room.id, 503);
        c.ws.send(Buffer.alloc(readLimits().maxMessageBytes + 1));
        const [code] = await once(c.ws, "close");
        assert.equal(code, 1009);
        a.ws.close();
        b.ws.close();
        await Promise.all([once(a.ws, "close"), once(b.ws, "close")]);
        await until(() => app.runtime.entries.size === 0);
        const fresh = await syncClient(room.id);
        assert.equal(fresh.doc.getMap("test").get("title"), "同步验证");
        fresh.ws.close();
        await once(fresh.ws, "close");
      },
    );
    await t.test(
      "离线累积超过 128 KB 的合法卡片，重连后同步并保存，重新加载内容完整",
      async () => {
        const offline = await syncClient(room.id);
        offline.ws.close();
        await once(offline.ws, "close");
        await until(() => app.runtime.entries.size === 0);
        for (let i = 0; i < 6; i++) {
          const node = new Y.Map();
          node.set("position", { x: i * 50, y: 0 });
          node.set(
            "data",
            new Y.Map([
              ["label", `卡片${i}`],
              ["content", "字".repeat(10000)],
              ["color", "mint"],
            ]),
          );
          offline.doc.getMap("nodes").set(`n${i}`, node);
        }
        const bytes = Y.encodeStateAsUpdate(offline.doc).length;
        assert.ok(bytes > 131072 && bytes < readLimits().maxDocumentBytes);
        const rejoined = await syncClient(room.id, offline.doc);
        await until(
          () =>
            app.runtime.entries.get(room.id)?.doc.getMap("nodes").size === 6,
        );
        rejoined.ws.close();
        await once(rejoined.ws, "close");
        await until(() => app.runtime.entries.size === 0);
        const fresh = await syncClient(room.id);
        assert.equal(fresh.doc.getMap("nodes").size, 6);
        assert.equal(
          fresh.doc.getMap("nodes").get("n5").get("data").get("content"),
          "字".repeat(10000),
        );
        fresh.ws.close();
        await once(fresh.ws, "close");
      },
    );

    await t.test(
      "数据库不可查询时仍反馈已知保存失败；恢复后可显式保存",
      async () => {
        const client = await syncClient(room.id);
        store.failSave = true;
        client.doc.getMap("test").set("unsaved", "database down");
        await until(() => app.runtime.status(room.id).saveState === "error");
        const get = store.get;
        store.get = async () => {
          throw new Error("database unavailable");
        };
        const response = await query(room.id);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).saveState, "error");
        store.get = get;
        store.failSave = false;
        const saved = await fetch(`${base}/api/rooms/${room.id}/save`, {
          method: "POST",
        });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).saveState, "saved");
        client.ws.close();
        await once(client.ws, "close");
      },
    );
    await t.test(
      "数据库删除失败不报成功；成功删除在线房间关闭所有连接并拒绝旧链接",
      async () => {
        const a = await syncClient(room.id);
        const b = await syncClient(room.id);
        store.failDelete = true;
        assert.equal((await remove(room.id, room.managementToken)).status, 503);
        assert.equal((await query(room.id)).status, 200);
        await until(
          () =>
            a.ws.readyState === WebSocket.CLOSED &&
            b.ws.readyState === WebSocket.CLOSED,
        );
        store.failDelete = false;
        const online = await syncClient(room.id);
        const closed = once(online.ws, "close");
        assert.equal((await remove(room.id, room.managementToken)).status, 204);
        assert.equal((await closed)[0], 4004);
        assert.equal((await query(room.id)).status, 404);
        await rejectUpgrade(room.id, 404);
        await until(() => app.runtime.entries.size === 0);
      },
    );
    await t.test(
      "文档超限关闭 4009，查询明确容量状态，重试返回 413，房主仍可删除",
      async () => {
        const small = await (
          await post(JSON.stringify({ title: "容量测试" }))
        ).json();
        const client = await syncClient(small.id);
        const previousLimit = limits.maxDocumentBytes;
        try {
          limits.maxDocumentBytes = 128;
          const closed = once(client.ws, "close");
          client.doc.getMap("test").set("content", "x".repeat(1000));
          assert.equal((await closed)[0], 4009);
          assert.equal(
            (await (await query(small.id)).json()).saveState,
            "too_large",
          );
          const response = await fetch(`${base}/api/rooms/${small.id}/save`, {
            method: "POST",
          });
          assert.equal(response.status, 413);
          assert.equal((await response.json()).saveState, "too_large");
          await rejectUpgrade(small.id, 413);
          assert.equal(
            (await remove(small.id, small.managementToken)).status,
            204,
          );
          await until(() => !app.runtime.entries.has(small.id));
        } finally {
          limits.maxDocumentBytes = previousLimit;
        }
      },
    );

    await t.test("房间总数上限限制并发创建", async () => {
      const statuses = await Promise.all(
        Array.from(
          { length: 7 },
          async () => (await post(JSON.stringify({ title: "限额" }))).status,
        ),
      );
      assert.equal(statuses.filter((status) => status === 201).length, 5);
      assert.equal(statuses.filter((status) => status === 503).length, 2);
    });
  },
);
