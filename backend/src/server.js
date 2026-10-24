import http from "node:http";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { createMySQLStore } from "./mysql-store.js";
import { createRoomRuntime, readLimits } from "./room-runtime.js";
import { readBoardFile, MAX_IMPORT_BYTES } from "../../shared/boardFile.mjs";

export const hashCredential = (token) =>
  createHash("sha256").update(token).digest();
const validId = (id) =>
  typeof id === "string" &&
  id.length >= 1 &&
  id.length <= 64 &&
  !/[^A-Za-z0-9_-]/.test(id);
const publicRoom = (room) => ({
  id: room.id,
  title: room.title,
  createdAt: room.createdAt,
});
function json(response, status, body) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export async function createApp({ store, limits = readLimits() }) {
  const runtime = await createRoomRuntime(store, limits);
  let creationQueue = Promise.resolve();
  let connectionCount = 0;
  let shuttingDown = false;
  const server = http.createServer(async (request, response) => {
    let requestedRoomId;
    try {
      if (shuttingDown) {
        json(response, 503, { message: "服务正在关闭。" });
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const importing = pathname === "/api/rooms/import";
      if (
        (pathname === "/api/rooms" || importing) &&
        request.method === "POST"
      ) {
        if (
          request.headers["content-type"]?.split(";")[0].trim() !==
          "application/json"
        ) {
          request.resume();
          json(response, 415, { message: "请使用 JSON 提交白板名称。" });
          return;
        }
        const chunks = [];
        const bodyLimit = importing ? MAX_IMPORT_BYTES : 4096;
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size <= bodyLimit) chunks.push(chunk);
        }
        if (size > bodyLimit) {
          json(response, 413, { message: "提交的数据过大。" });
          return;
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json(response, 400, { message: "提交的数据不是有效的 JSON。" });
          return;
        }
        if (
          typeof body?.title !== "string" ||
          !body.title.trim() ||
          body.title.trim().length > 40
        ) {
          json(response, 400, { message: "白板名称须为 1～40 字。" });
          return;
        }
        const credential = randomBytes(32).toString("base64url");
        const imported = importing ? readBoardFile(body) : null;
        const emptyDoc = new Y.Doc();
        if (imported) {
          emptyDoc.transact(() => {
            for (const node of imported.nodes) {
              const item = new Y.Map();
              item.set("position", node.position);
              item.set("data", new Y.Map(Object.entries(node.data)));
              emptyDoc.getMap("nodes").set(node.id, item);
            }
            for (const edge of imported.edges)
              emptyDoc.getMap("edges").set(edge.id, edge);
          });
        }
        const room = {
          id: randomUUID(),
          title: body.title.trim(),
          createdAt: Date.now(),
          managementHash: hashCredential(credential),
          state: Buffer.from(Y.encodeStateAsUpdate(emptyDoc)),
        };
        emptyDoc.destroy();
        if (room.state.length > limits.maxDocumentBytes) {
          json(response, 413, { message: "导入内容超过白板容量上限。" });
          return;
        }
        const create = creationQueue.then(() =>
          store.create(room, limits.maxRooms),
        );
        creationQueue = create.catch(() => {});
        await create;
        json(response, 201, {
          ...publicRoom(room),
          managementToken: credential,
        });
        return;
      }
      const match = /^\/api\/rooms\/([^/]+)(\/save)?$/.exec(pathname);
      if (match) {
        let id;
        try {
          id = decodeURIComponent(match[1]);
        } catch {
          /* 返回无效地址 */
        }
        if (!validId(id)) {
          json(response, 400, { message: "房间地址无效。" });
          return;
        }
        requestedRoomId = id;
        const room = await store.get(id);
        if (!room) {
          json(response, 404, { message: "房间不存在或已删除。" });
          return;
        }
        if (match[2] && request.method === "POST") {
          if (
            runtime.status(id, room.updatedAt, room.stateBytes).saveState ===
            "too_large"
          ) {
            json(response, 413, {
              saveState: "too_large",
              message:
                "白板超过容量上限，重试保存无法解决。请联系维护者处理或由房主删除房间。",
            });
            return;
          }
          await runtime.retry(id);
          json(response, 200, runtime.status(id, room.updatedAt));
          return;
        }
        if (!match[2] && request.method === "GET") {
          json(response, 200, {
            ...publicRoom(room),
            ...runtime.status(id, room.updatedAt, room.stateBytes),
          });
          return;
        }
        if (!match[2] && request.method === "DELETE") {
          const token = request.headers["x-room-management-token"];
          if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
            json(response, 401, { message: "缺少有效的房间管理凭证。" });
            return;
          }
          const actual = hashCredential(token);
          if (
            !Buffer.isBuffer(room.managementHash) ||
            room.managementHash.length !== actual.length ||
            !timingSafeEqual(actual, room.managementHash)
          ) {
            json(response, 403, { message: "房间管理凭证错误。" });
            return;
          }
          await runtime.deleteRoom(id);
          response.writeHead(204);
          response.end();
          return;
        }
        response.setHeader("Allow", match[2] ? "POST" : "GET, DELETE");
        json(response, 405, { message: "请求方法不支持。" });
        return;
      }
      if (pathname === "/api/rooms") {
        response.setHeader("Allow", "POST");
        json(response, 405, { message: "请使用 POST 创建房间。" });
        return;
      }
      if (pathname === "/" && request.method === "GET") {
        response.end("ok");
        return;
      }
      json(response, 404, { message: "接口不存在。" });
    } catch (error) {
      // 驱动异常可能含 SQL/连接信息，不将异常对象写入日志或返回客户端。
      json(response, error.status || 503, {
        ...(requestedRoomId && runtime.entries.has(requestedRoomId)
          ? { saveState: runtime.status(requestedRoomId).saveState }
          : {}),
        message: error.status
          ? error.message
          : "数据库暂时不可用，操作未确认成功，请稍后重试。",
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = limits.maxConnections + 20;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxMessageBytes,
  });
  server.on("upgrade", async (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    let entry;
    let counted = false;
    const reject = (status) =>
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    try {
      let id;
      try {
        id = decodeURIComponent(
          new URL(request.url, "http://localhost").pathname.slice(1),
        );
      } catch {
        reject(400);
        return;
      }
      if (!validId(id)) {
        reject(404);
        return;
      }
      if (shuttingDown || connectionCount >= limits.maxConnections) {
        reject(503);
        return;
      }
      connectionCount++;
      counted = true;
      if (!(await store.get(id))) {
        reject(404);
        return;
      }
      // 持有进入租约直到握手结束，保存期间重连会复用同一 entry。
      entry = await runtime.acquire(id);
      if (socket.destroyed || entry.deleting || shuttingDown) {
        reject(503);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        counted = false;
        ws.once("close", () => {
          connectionCount--;
        });
        runtime.attach(entry, ws, request);
      });
    } catch (error) {
      if (!socket.destroyed) reject(error.status || 503);
    } finally {
      if (counted) connectionCount--;
      if (entry) runtime.release(entry);
    }
  });
  return {
    server,
    runtime,
    async close() {
      shuttingDown = true;
      const closed = new Promise((resolve) => server.close(resolve));
      const saved = await runtime.close();
      server.closeAllConnections();
      await closed;
      wss.close();
      await store.close();
      return saved;
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const limits = readLimits();
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("PORT 配置无效。");
    const store = await createMySQLStore();
    try {
      await store.check();
    } catch (error) {
      await store.close();
      throw error;
    }
    const app = await createApp({ store, limits });
    app.server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
      console.log(
        `Flowboard HTTP / WebSocket 服务已启动，端口:${app.server.address().port}`,
      ),
    );
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => {
        console.error("关闭保存超时，可能仍有未保存修改。");
        process.exit(1);
      }, limits.shutdownTimeout);
      const saved = await app.close().catch(() => false);
      clearTimeout(deadline);
      if (!saved)
        console.error("关闭时仍有保存失败的房间；本次未保存修改可能丢失。");
      process.exit(saved ? 0 : 1);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(
      error.message?.startsWith("缺少 ")
        ? error.message
        : "启动失败，请检查 MySQL 驱动、数据库配置和建表情况（未输出连接凭据）。",
    );
    process.exitCode = 1;
  }
}
