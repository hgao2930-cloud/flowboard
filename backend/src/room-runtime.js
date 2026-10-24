import * as Y from "yjs";

export function readLimits(env = process.env) {
  const integer = (key, fallback, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${key} 配置无效。`);
    return value;
  };
  const maxDocumentBytes = integer("MAX_DOCUMENT_BYTES", 4194304, 16000000);
  // 重连会合并离线更新；单条同步消息必须能容纳允许的文档及协议开销。
  const maxMessageBytes = integer(
    "MAX_WS_MESSAGE_BYTES",
    maxDocumentBytes + 65536,
    16065536,
  );
  if (maxMessageBytes < maxDocumentBytes + 65536)
    throw new Error(
      "MAX_WS_MESSAGE_BYTES 至少应为 MAX_DOCUMENT_BYTES + 65536。",
    );
  return {
    maxRooms: integer("MAX_ROOMS", 200, 10000),
    maxActiveRooms: integer("MAX_ACTIVE_ROOMS", 20, 200),
    maxConnections: integer("MAX_CONNECTIONS", 40, 500),
    maxMessageBytes,
    maxDocumentBytes,
    saveInterval: integer("SAVE_INTERVAL_MS", 2000, 10000),
    retryBase: integer("SAVE_RETRY_BASE_MS", 1000, 10000),
    retries: integer("SAVE_RETRIES", 3, 5),
    shutdownTimeout: integer("SHUTDOWN_TIMEOUT_MS", 12000, 30000),
  };
}

const unavailable = () =>
  Object.assign(new Error("房间正在关闭、删除或资源已满，请稍后重试。"), {
    status: 503,
  });
const tooLarge = () =>
  Object.assign(
    new Error(
      "白板超过容量上限，重试保存无法解决。请联系维护者处理或由房主删除房间。",
    ),
    {
      status: 413,
      code: "DOCUMENT_TOO_LARGE",
    },
  );

export async function createRoomRuntime(store, limits = readLimits()) {
  if (process.env.YPERSISTENCE)
    throw new Error("请移除 YPERSISTENCE；本项目只使用 MySQL。");
  const { getYDoc, docs, setPersistence, setupWSConnection } =
    await import("@y/websocket-server/utils");
  // 不启用依赖的 writeState：它会在异步保存前移除 docs，重连时可能出现第二份文档。
  setPersistence(null);
  const entries = new Map();
  let stopping = false;

  function dispose(entry) {
    if (
      entry.disposed ||
      entry.doc?.conns.size ||
      entry.pending ||
      entry.saving
    )
      return;
    entry.disposed = true;
    clearTimeout(entry.timer);
    if (entry.doc) {
      entry.doc.off("update", entry.onUpdate);
      if (docs.get(entry.id) === entry.doc) docs.delete(entry.id);
      entry.doc.destroy(); // 同时销毁 Awareness；连接 close 回调已清除各自的心跳。
    }
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
  }
  function schedule(entry, delay) {
    if (
      stopping ||
      entry.deleting ||
      entry.error === "too_large" ||
      entry.timer ||
      entry.failures > limits.retries
    )
      return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flush(entry).catch(() => {});
    }, delay);
  }
  function freezeConnections(entry, code, reason) {
    for (const ws of entry.doc?.conns.keys() ?? []) {
      // setupWSConnection 的协议监听器也移除，删除期间任何后续帧都不能再写入文档。
      ws.removeAllListeners("message");
      ws.close(code, reason);
      const timer = setTimeout(() => ws.terminate(), 500);
      timer.unref();
      ws.once("close", () => clearTimeout(timer));
    }
  }
  async function flush(entry) {
    if (entry.deleting || !entry.doc) return;
    if (entry.error === "too_large") throw tooLarge();
    if (entry.saving) return entry.saving;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.version === entry.savedVersion) {
      if (!entry.pending && entry.doc.conns.size === 0) dispose(entry);
      return;
    }
    const version = entry.version;
    entry.saving = Promise.resolve().then(async () => {
      try {
        const state = Y.encodeStateAsUpdate(entry.doc);
        if (state.length > limits.maxDocumentBytes) {
          throw tooLarge();
        }
        const savedAt = Date.now();
        await store.save(entry.id, Buffer.from(state), savedAt, version);
        entry.savedVersion = version;
        entry.savedAt = savedAt;
        entry.error = false;
        entry.failures = 0;
      } catch (error) {
        if (error.code === "DOCUMENT_TOO_LARGE") {
          entry.error = "too_large";
          freezeConnections(entry, 4009, "Document too large");
          console.error(
            `房间 ${entry.id} 超过文档容量，已停止协作和自动保存；未保存内容仍在内存。`,
          );
          throw error;
        }
        entry.error = true;
        entry.failures++;
        if (entry.failures > limits.retries)
          freezeConnections(entry, 1013, "Save failed; retry required");
        // 不输出 SQL、密码、请求头或凭证；保留唯一未保存的文档。
        console.error(
          `房间 ${entry.id} 保存失败（第 ${entry.failures} 次），未保存内容仍在内存。`,
        );
        throw error;
      } finally {
        entry.saving = null;
        if (!entry.deleting && entry.version !== entry.savedVersion) {
          schedule(
            entry,
            entry.error ? limits.retryBase * 2 ** (entry.failures - 1) : 0,
          );
        } else if (
          !entry.deleting &&
          !entry.pending &&
          entry.doc.conns.size === 0
        )
          dispose(entry);
      }
    });
    return entry.saving;
  }
  function release(entry) {
    entry.pending--;
    idle(entry);
  }
  function idle(entry) {
    if (entry.pending || entry.doc?.conns.size) return;
    if (entry.deleted) {
      dispose(entry);
      return;
    }
    if (
      entry.deleting ||
      !entry.doc ||
      entry.saving ||
      entry.error === "too_large"
    )
      return;
    if (entry.version === entry.savedVersion) dispose(entry);
    else if (!stopping && entry.failures <= limits.retries && !entry.timer)
      void flush(entry).catch(() => {});
  }
  async function acquire(id) {
    if (stopping) throw unavailable();
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= limits.maxActiveRooms) throw unavailable();
      entry = {
        id,
        pending: 0,
        doc: null,
        timer: null,
        saving: null,
        version: 0,
        savedVersion: 0,
        savedAt: null,
        failures: 0,
        error: false,
        deleting: false,
      };
      entries.set(id, entry);
      entry.ready = (async () => {
        const loaded = await store.load(id);
        if (loaded === null)
          throw Object.assign(new Error("房间不存在。"), { status: 404 });
        if (loaded.state.length > limits.maxDocumentBytes) throw tooLarge();
        entry.version = entry.savedVersion = loaded.revision;
        entry.savedAt = loaded.savedAt;
        entry.doc = getYDoc(id);
        try {
          Y.applyUpdate(entry.doc, new Uint8Array(loaded.state));
        } catch (error) {
          if (docs.get(id) === entry.doc) docs.delete(id);
          entry.doc.destroy();
          entry.doc = null;
          throw error;
        }
        entry.onUpdate = () => {
          entry.version++;
          // 首次变更起固定窗口；后续拖动不会把保存时间无限推迟。
          schedule(entry, limits.saveInterval);
        };
        entry.doc.on("update", entry.onUpdate);
      })();
    }
    if (entry.error === "too_large") throw tooLarge();
    if (entry.deleting || entry.failures > limits.retries) throw unavailable();
    entry.pending++;
    try {
      await entry.ready;
      if (entry.deleting || stopping) throw unavailable();
      return entry;
    } catch (error) {
      release(entry);
      if (!entry.doc && !entry.deleting && entries.get(id) === entry)
        entries.delete(id);
      throw error;
    }
  }
  function attach(entry, ws, request) {
    if (entry.deleting || stopping) {
      ws.close(1013);
      return;
    }
    setupWSConnection(ws, request, { docName: entry.id });
    ws.on("error", () => {});
    ws.once("close", () => idle(entry));
  }
  async function deleteRoom(id) {
    let entry = entries.get(id);
    if (entry?.deleting) throw unavailable();
    if (!entry) {
      entry = { id, pending: 0, doc: null, saving: null };
      entries.set(id, entry);
    }
    entry.deleting = true;
    clearTimeout(entry.timer);
    entry.timer = null;
    await entry.ready?.catch(() => {});
    // 暂存协议监听器。删除失败后关闭连接，客户端重连会补发冻结期间的本地更新。
    for (const ws of entry.doc?.conns.keys() ?? [])
      ws.removeAllListeners("message");
    await entry.saving?.catch(() => {});
    try {
      await store.delete(id);
      entry.deleted = true;
      freezeConnections(entry, 4004, "Room deleted");
      dispose(entry);
    } catch (error) {
      freezeConnections(entry, 1013, "Delete failed; reconnect");
      entry.deleting = false;
      if (entry.doc) {
        schedule(entry, limits.saveInterval);
        idle(entry);
      } else dispose(entry);
      throw error;
    }
  }
  return {
    entries,
    acquire,
    release,
    attach,
    deleteRoom,
    status(id, updatedAt, stateBytes = 0) {
      const entry = entries.get(id);
      return {
        saveState:
          entry?.error === "too_large" || stateBytes > limits.maxDocumentBytes
            ? "too_large"
            : entry?.error
              ? "error"
              : entry && entry.version !== entry.savedVersion
                ? "pending"
                : "saved",
        savedAt: entry?.savedAt ?? updatedAt,
      };
    },
    async retry(id) {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.deleting) throw unavailable();
      if (entry.error === "too_large") throw tooLarge();
      if (entry.lastRetry && Date.now() - entry.lastRetry < 5000)
        throw unavailable();
      entry.lastRetry = Date.now();
      entry.failures = 0;
      await flush(entry);
    },
    async close() {
      stopping = true;
      const current = [...entries.values()];
      for (const entry of current) {
        clearTimeout(entry.timer);
        freezeConnections(entry, 1012, "Server restarting");
      }
      const results = await Promise.allSettled(
        current.map(async (entry) => {
          await entry.ready?.catch(() => {});
          await entry.saving?.catch(() => {});
          await flush(entry);
        }),
      );
      return results.every((result) => result.status === "fulfilled");
    },
  };
}
