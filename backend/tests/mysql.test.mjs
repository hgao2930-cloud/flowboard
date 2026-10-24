import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import * as Y from "yjs";
import { createMySQLStore } from "../src/mysql-store.js";
import { createRoomRuntime, readLimits } from "../src/room-runtime.js";
import { hashCredential } from "../src/server.js";
import { until, deferred } from "./helpers.mjs";

const configured = Boolean(process.env.TEST_MYSQL_DATABASE);
test(
  "真实 MySQL：双客户端合并、退出释放、后端重建、完整文档恢复与删除竞争",
  {
    skip: configured
      ? false
      : "未配置独立 TEST_MYSQL_DATABASE；没有执行真实数据库持久化验证",
    timeout: 30000,
  },
  async (t) => {
    // 严格隔离：不用普通 MYSQL_* 回退；不连接线上地址，不清表，仅删除本测试创建的 UUID 行。
    const env = Object.fromEntries(
      ["HOST", "PORT", "DATABASE", "USER", "PASSWORD"].map((key) => [
        `MYSQL_${key}`,
        process.env[`TEST_MYSQL_${key}`],
      ]),
    );
    assert.match(env.MYSQL_DATABASE, /^flowboard_test_[A-Za-z0-9_]+$/);
    assert.ok(
      ["localhost", "127.0.0.1", "::1"].includes(env.MYSQL_HOST),
      "仅允许明确配置的本机独立测试库",
    );
    const { createConnection } = await import("mysql2/promise");
    const connection = await createConnection({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT || 3306),
      database: env.MYSQL_DATABASE,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
    });
    try {
      await connection.query(
        await readFile(
          new URL("../sql/001_rooms.sql", import.meta.url),
          "utf8",
        ),
      );
    } finally {
      await connection.end();
    }
    const id = randomUUID();
    let store = await createMySQLStore(env);
    let runtime = await createRoomRuntime(store, {
      ...readLimits(),
      saveInterval: 30,
    });
    t.after(async () => {
      await runtime.close();
      if (await store.get(id)) await store.delete(id);
      await store.close();
    });
    const a = new Y.Doc(),
      b = new Y.Doc(),
      empty = new Y.Doc();
    t.after(() => {
      a.destroy();
      b.destroy();
      empty.destroy();
    });
    const token = randomBytes(32).toString("base64url");
    await store.create(
      {
        id,
        title: "重启后仍存在",
        createdAt: Date.now(),
        managementHash: hashCredential(token),
        state: Buffer.from(Y.encodeStateAsUpdate(empty)),
      },
      10000,
    );
    const entry = await runtime.acquire(id);
    const node = (label) =>
      new Y.Map([
        ["position", { x: 10, y: 20 }],
        [
          "data",
          new Y.Map([
            ["label", label],
            ["content", "正文"],
          ]),
        ],
      ]);
    a.getMap("nodes").set("a", node("A"));
    b.getMap("nodes").set("b", node("B"));
    Y.applyUpdate(entry.doc, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(entry.doc, Y.encodeStateAsUpdate(b));
    entry.doc.getMap("edges").set("e", { id: "e", source: "a", target: "b" });
    const expected = {
      nodes: entry.doc.getMap("nodes").toJSON(),
      edges: entry.doc.getMap("edges").toJSON(),
    };
    runtime.release(entry);
    await until(() => runtime.entries.size === 0);
    await runtime.close();
    await store.close();
    // 丢弃应用实例和连接池，从数据库创建全新文档；不依赖先前内存。
    store = await createMySQLStore(env);
    runtime = await createRoomRuntime(store, {
      ...readLimits(),
      saveInterval: 30,
    });
    const metadata = await store.get(id);
    assert.equal(metadata.title, "重启后仍存在");
    assert.deepEqual(metadata.managementHash, hashCredential(token));
    const restored = await runtime.acquire(id);
    const freshClient = new Y.Doc();
    try {
      Y.applyUpdate(freshClient, Y.encodeStateAsUpdate(restored.doc));
      assert.deepEqual(
        {
          nodes: freshClient.getMap("nodes").toJSON(),
          edges: freshClient.getMap("edges").toJSON(),
        },
        expected,
      );
    } finally {
      freshClient.destroy();
    }
    const saving = deferred();
    const continueSave = deferred();
    const save = store.save.bind(store);
    store.save = async (...args) => {
      saving.resolve();
      await continueSave.promise;
      return save(...args);
    };
    restored.doc.getMap("nodes").get("a").set("position", { x: 999, y: 888 });
    await saving.promise;
    const deleting = runtime.deleteRoom(id);
    continueSave.resolve();
    await deleting;
    runtime.release(restored);
    assert.equal(await store.get(id), null);
    assert.equal(await store.load(id), null);
    await assert.rejects(save(id, Buffer.from([0, 0]), Date.now(), 99999), {
      status: 404,
    });
    assert.equal(await store.get(id), null);
  },
);
