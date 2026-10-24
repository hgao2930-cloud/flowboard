import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import * as Y from "yjs";
import { createApp } from "../src/server.js";
import { testStore } from "./helpers.mjs";
import { readBoardFile, MAX_IMPORT_BYTES } from "../../shared/boardFile.mjs";
const sample = () => ({
  format: "flowboard",
  version: 1,
  title: "导入测试",
  nodes: [
    {
      id: "a",
      position: { x: 12, y: -34 },
      data: { label: "标题", content: "正文", color: "mint" },
    },
    {
      id: "b",
      position: { x: 50, y: 60 },
      data: { label: "第二个", content: "", color: "blue" },
    },
  ],
  edges: [{ id: "edge", source: "a", target: "b" }],
});
test("文件往返保留图内容，移除管理凭证与额外字段", () => {
  const value = sample();
  value.managementToken = "secret";
  value.nodes[0].selected = true;
  const clean = readBoardFile(value);
  assert.equal(clean.managementToken, undefined);
  assert.equal(clean.nodes[0].selected, undefined);
  assert.deepEqual(readBoardFile(JSON.parse(JSON.stringify(clean))), clean);
});
test("拒绝未知版本、非法坐标、重复节点和悬空连线", () => {
  for (const mutate of [
    (v) => (v.version = 2),
    (v) => (v.nodes[0].position.x = Infinity),
    (v) => v.nodes.push(v.nodes[0]),
    (v) => (v.edges[0].target = "missing"),
    (v) => (v.edges[0].sourceHandle = "invalid"),
  ]) {
    const v = sample();
    mutate(v);
    assert.throws(() => readBoardFile(v));
  }
  assert.equal(
    readBoardFile({ ...sample(), nodes: [], edges: [] }).nodes.length,
    0,
  );
});
test("导入原子创建新房间和新凭证；非法文件及超限不产生房间", async (t) => {
  const store = testStore();
  const app = await createApp({ store });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}/api/rooms/import`;
  const post = (v) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
  const response = await post(sample());
  assert.equal(response.status, 201);
  const room = await response.json();
  assert.match(room.managementToken, /^[\w-]{43}$/);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await store.load(room.id)).state);
  assert.deepEqual(doc.getMap("nodes").get("a").toJSON(), {
    position: { x: 12, y: -34 },
    data: { label: "标题", content: "正文", color: "mint" },
  });
  assert.equal(doc.getMap("edges").size, 1);
  doc.destroy();
  const second = await (await post(sample())).json();
  assert.notEqual(second.id, room.id);
  assert.notEqual(second.managementToken, room.managementToken);
  const invalid = sample();
  invalid.edges[0].target = "missing";
  assert.equal((await post(invalid)).status, 400);
  const large = sample();
  large.nodes[0].data.content = "x".repeat(MAX_IMPORT_BYTES);
  assert.equal((await post(large)).status, 413);
  assert.equal(store.rows.size, 2);
});
