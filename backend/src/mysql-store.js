// SQL 只在此文件中。正常运行必须使用 MySQL；测试替身只能由测试代码注入。
export async function createMySQLStore(env = process.env) {
  for (const key of [
    "MYSQL_HOST",
    "MYSQL_DATABASE",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
  ]) {
    if (!env[key]) throw new Error(`缺少 ${key}，请配置 backend/.env。`);
  }
  const { createPool } = await import("mysql2/promise");
  const poolSize = Number(env.MYSQL_POOL_SIZE || 3);
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 5)
    throw new Error("MYSQL_POOL_SIZE 必须为 1～5。");
  const pool = createPool({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT || 3306),
    database: env.MYSQL_DATABASE,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    connectionLimit: poolSize,
    maxIdle: Math.min(2, poolSize),
    waitForConnections: true,
    queueLimit: 20,
    connectTimeout: 5000,
    enableKeepAlive: true,
  });
  const query = (connection, sql, values = []) =>
    connection.execute({ sql, timeout: 5000 }, values);
  return {
    async check() {
      await query(pool, "SELECT id FROM flowboard_rooms LIMIT 1");
    },
    async create(room, maxRooms) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // 调用方在单进程中串行创建；不支持多个后端实例同时运行。
        const [rows] = await query(
          connection,
          "SELECT COUNT(*) AS count FROM flowboard_rooms",
        );
        if (Number(rows[0].count) >= maxRooms) {
          throw Object.assign(new Error("房间数量已达演示上限。"), {
            status: 503,
          });
        }
        await query(
          connection,
          "INSERT INTO flowboard_rooms (id, title, management_hash, y_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            room.id,
            room.title,
            room.managementHash,
            room.state,
            room.createdAt,
            room.createdAt,
          ],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async get(id) {
      const [rows] = await query(
        pool,
        "SELECT id, title, management_hash, created_at, updated_at, OCTET_LENGTH(y_state) AS state_bytes FROM flowboard_rooms WHERE id = ?",
        [id],
      );
      const row = rows[0];
      return row
        ? {
            id: row.id,
            title: row.title,
            managementHash: row.management_hash,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            stateBytes: Number(row.state_bytes),
          }
        : null;
    },
    async load(id) {
      const [rows] = await query(
        pool,
        "SELECT y_state, revision, updated_at FROM flowboard_rooms WHERE id = ?",
        [id],
      );
      return rows[0]
        ? {
            state: rows[0].y_state,
            revision: Number(rows[0].revision),
            savedAt: Number(rows[0].updated_at),
          }
        : null;
    },
    async save(id, state, now, revision) {
      // 永远 UPDATE，不使用 UPSERT：迟到的保存不能重建已删除的房间。
      const [result] = await query(
        pool,
        "UPDATE flowboard_rooms SET y_state = ?, updated_at = ?, revision = ? WHERE id = ? AND revision < ?",
        [state, now, revision, id, revision],
      );
      if (result.affectedRows !== 1 && !(await this.get(id)))
        throw Object.assign(new Error("房间不存在。"), { status: 404 });
    },
    async delete(id) {
      // 元数据与文档在同一行，InnoDB 单语句删除是原子的。
      const [result] = await query(
        pool,
        "DELETE FROM flowboard_rooms WHERE id = ?",
        [id],
      );
      if (result.affectedRows !== 1)
        throw Object.assign(new Error("房间不存在。"), { status: 404 });
    },
    close: () => pool.end(),
  };
}
