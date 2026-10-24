import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createRoomRuntime, readLimits } from "../src/room-runtime.js";
import { testStore, seed, until, deferred } from "./helpers.mjs";

const limits = { ...readLimits(), saveInterval: 35, retryBase: 10, retries: 2 };

test("同步消息上限覆盖完整文档及协议开销，拒绝不匹配的环境配置", () => {
  const defaults = readLimits({});
  assert.equal(defaults.maxMessageBytes, defaults.maxDocumentBytes + 65536);
  assert.equal(
    readLimits({ MAX_DOCUMENT_BYTES: "8000000" }).maxMessageBytes,
    8065536,
  );
  assert.throws(
    () => readLimits({ MAX_WS_MESSAGE_BYTES: "131072" }),
    /MAX_WS_MESSAGE_BYTES/,
  );
});

test("保存和释放后重新加载完整 Yjs；空文档也保持为空", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  const entry = await runtime.acquire(id);
  const node = new Y.Map();
  node.set("position", { x: 12, y: 24 });
  node.set(
    "data",
    new Y.Map([
      ["label", "节点"],
      ["content", "正文"],
    ]),
  );
  entry.doc.getMap("nodes").set("n1", node);
  entry.doc.getMap("edges").set("e1", { id: "e1", source: "n1", target: "n2" });
  const expected = Y.encodeStateAsUpdate(entry.doc);
  runtime.release(entry);
  await until(() => runtime.entries.size === 0);
  const loaded = await runtime.acquire(id);
  assert.notEqual(loaded.doc, entry.doc);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, expected);
  assert.deepEqual(
    loaded.doc.getMap("nodes").toJSON(),
    fresh.getMap("nodes").toJSON(),
  );
  assert.deepEqual(
    loaded.doc.getMap("edges").toJSON(),
    fresh.getMap("edges").toJSON(),
  );
  loaded.doc.getMap("nodes").clear();
  loaded.doc.getMap("edges").clear();
  runtime.release(loaded);
  await until(() => runtime.entries.size === 0);
  const empty = await runtime.acquire(id);
  assert.equal(empty.doc.getMap("nodes").size, 0);
  runtime.release(empty);
  fresh.destroy();
  await runtime.close();
});

test("持续编辑不会无限推迟保存，异步保存顺序与最新状态正确", async (t) => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  const entry = await runtime.acquire(id);
  const gate = deferred();
  store.beforeSave = () => gate.promise;
  entry.doc.getMap("test").set("v", 1);
  const continuousInput = setInterval(
    () => entry.doc.getMap("test").set("tick", Date.now()),
    5,
  );
  t.after(() => clearInterval(continuousInput));
  await until(() => store.saveCount === 1);
  clearInterval(continuousInput);
  for (let value = 2; value <= 20; value++)
    entry.doc.getMap("test").set("v", value);
  assert.equal(store.saveCount, 1);
  gate.resolve();
  await until(() => runtime.status(id).saveState === "saved");
  assert.equal(store.saveCount, 2);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, store.rows.get(id).state);
  assert.equal(restored.getMap("test").get("v"), 20);
  runtime.release(entry);
  restored.destroy();
  await runtime.close();
});

test("活动房间上限包括尚在加载的房间；释放后可进入另一个房间", async () => {
  const store = testStore();
  const a = await seed(store),
    b = await seed(store);
  const runtime = await createRoomRuntime(store, {
    ...limits,
    maxActiveRooms: 1,
  });
  const first = await runtime.acquire(a);
  await assert.rejects(runtime.acquire(b), { status: 503 });
  runtime.release(first);
  const second = await runtime.acquire(b);
  runtime.release(second);
  await runtime.close();
});

test("最后退出正在保存时重进，共用一份文档，不会误释放新连接", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  const entry = await runtime.acquire(id);
  const gate = deferred();
  store.beforeSave = () => gate.promise;
  entry.doc.getMap("test").set("v", "first");
  runtime.release(entry);
  await until(() => store.saveCount === 1);
  const rejoined = await runtime.acquire(id);
  assert.equal(entry.doc, rejoined.doc);
  rejoined.doc.getMap("test").set("v", "second");
  gate.resolve();
  await until(() => runtime.status(id).saveState === "saved");
  assert.equal(runtime.entries.size, 1);
  runtime.release(rejoined);
  await until(() => runtime.entries.size === 0);
  await runtime.close();
});

test("保存失败有界重试，保留唯一未保存文档，数据库恢复后显式重试释放", async () => {
  const store = testStore();
  const id = await seed(store);
  store.failSave = true;
  const runtime = await createRoomRuntime(store, limits);
  const entry = await runtime.acquire(id);
  entry.doc.getMap("test").set("v", "unsaved");
  runtime.release(entry);
  await until(() => store.saveCount === 3 && !entry.saving);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(store.saveCount, 3);
  assert.equal(runtime.status(id).saveState, "error");
  assert.equal(runtime.entries.get(id).doc.getMap("test").get("v"), "unsaved");
  await assert.rejects(runtime.acquire(id), { status: 503 });
  store.failSave = false;
  await runtime.retry(id);
  await until(() => runtime.entries.size === 0);
  const loaded = await runtime.acquire(id);
  assert.equal(loaded.doc.getMap("test").get("v"), "unsaved");
  runtime.release(loaded);
  await runtime.close();
});

test("删除等待正在写库的保存，删除后迟到操作和重连不能复活房间", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  const entry = await runtime.acquire(id);
  const gate = deferred();
  store.beforeSave = () => gate.promise;
  entry.doc.getMap("test").set("v", "old");
  await until(() => store.saveCount === 1);
  const deleting = runtime.deleteRoom(id);
  await assert.rejects(runtime.acquire(id), { status: 503 });
  gate.resolve();
  await deleting;
  runtime.release(entry);
  assert.equal(store.rows.has(id), false);
  assert.equal(runtime.entries.size, 0);
  await assert.rejects(runtime.acquire(id), { status: 404 });
  assert.equal(runtime.entries.size, 0);
  await runtime.close();
});

test("删除失败保留资料与文档；加载失败不暴露空白文档，重试可恢复", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  store.beforeLoad = () => {
    throw new Error("database offline");
  };
  await assert.rejects(runtime.acquire(id), /database offline/);
  assert.equal(runtime.entries.size, 0);
  store.beforeLoad = null;
  const entry = await runtime.acquire(id);
  entry.doc.getMap("test").set("v", "keep");
  store.failDelete = true;
  await assert.rejects(runtime.deleteRoom(id), /delete failure/);
  assert.equal(store.rows.has(id), true);
  assert.equal(entry.doc.getMap("test").get("v"), "keep");
  runtime.release(entry);
  await runtime.close();
});

test("并发首次进入等待同一次加载；加载中删除不会留下可用实例", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  const gate = deferred();
  let loads = 0;
  store.beforeLoad = () => {
    loads++;
    return gate.promise;
  };
  const first = runtime.acquire(id);
  const second = runtime.acquire(id);
  const rejected = Promise.all([assert.rejects(first), assert.rejects(second)]);
  const deleting = runtime.deleteRoom(id);
  gate.resolve();
  await Promise.all([deleting, rejected]);
  assert.equal(loads, 1);
  assert.equal(runtime.entries.size, 0);
  assert.equal(store.rows.has(id), false);
  await runtime.close();
});

test("正常关闭尝试最终保存；保存失败明确返回失败，不销毁唯一未保存内容", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, limits);
  const entry = await runtime.acquire(id);
  entry.doc.getMap("test").set("v", "shutdown data");
  store.failSave = true;
  runtime.release(entry);
  assert.equal(await runtime.close(), false);
  assert.equal(
    runtime.entries.get(id).doc.getMap("test").get("v"),
    "shutdown data",
  );
  store.failSave = false;
  await runtime.retry(id);
  assert.equal(await runtime.close(), true);
  assert.equal(runtime.entries.size, 0);
});

test("超限文档立即停止重试、不裁剪或释放，返回明确容量状态且仍可删除", async () => {
  const store = testStore();
  const id = await seed(store);
  const runtime = await createRoomRuntime(store, {
    ...limits,
    maxDocumentBytes: 128,
  });
  const entry = await runtime.acquire(id);
  entry.doc.getMap("test").set("large", "x".repeat(1000));
  runtime.release(entry);
  await until(() => entry.error === "too_large" && !entry.saving);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(entry.timer, null);
  assert.equal(entry.failures, 0);
  assert.equal(entry.doc.getMap("test").get("large").length, 1000);
  assert.equal(runtime.status(id).saveState, "too_large");
  assert.equal(store.saveCount, 0);
  await assert.rejects(runtime.retry(id), { status: 413 });
  await assert.rejects(runtime.acquire(id), { status: 413 });
  assert.equal(
    runtime.status("unloaded", Date.now(), 129).saveState,
    "too_large",
  );
  await runtime.deleteRoom(id);
  assert.equal(runtime.entries.size, 0);
  await runtime.close();
});
