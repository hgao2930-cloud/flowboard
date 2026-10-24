import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { hashCredential } from "../src/server.js";

// 仅供生命周期/HTTP 测试；不代表已经验证 MySQL，也没有可启用此替身的生产开关。
export function testStore() {
  const rows = new Map();
  return {
    rows,
    saveCount: 0,
    failSave: false,
    failDelete: false,
    beforeSave: null,
    beforeLoad: null,
    async create(room, maxRooms) {
      if (rows.size >= maxRooms)
        throw Object.assign(new Error("房间上限。"), { status: 503 });
      rows.set(room.id, { ...room, revision: 0, updatedAt: room.createdAt });
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async load(id) {
      await this.beforeLoad?.();
      const row = rows.get(id);
      return row
        ? {
            state: Buffer.from(row.state),
            revision: row.revision,
            savedAt: row.updatedAt,
          }
        : null;
    },
    async save(id, state, now, revision) {
      this.saveCount++;
      await this.beforeSave?.();
      if (this.failSave) throw new Error("simulated database unavailable");
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error("房间不存在。"), { status: 404 });
      if (row.revision < revision)
        rows.set(id, {
          ...row,
          state: Buffer.from(state),
          revision,
          updatedAt: now,
        });
    },
    async delete(id) {
      if (this.failDelete) throw new Error("simulated delete failure");
      rows.delete(id);
    },
    async close() {},
  };
}
export async function seed(store, title = "生命周期测试") {
  const doc = new Y.Doc();
  const id = randomUUID();
  await store.create(
    {
      id,
      title,
      createdAt: Date.now(),
      managementHash: hashCredential("a".repeat(43)),
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    },
    10000,
  );
  doc.destroy();
  return id;
}
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
export async function until(condition, timeout = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("等待测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
