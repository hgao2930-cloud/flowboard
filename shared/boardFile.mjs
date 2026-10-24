export const MAX_IMPORT_BYTES = 1024 * 1024;
const colors = ["mint", "blue", "violet", "amber", "rose"];
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function requireValid(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { status: 400 });
}

// 前后端共用文件协议；显式挑选字段，不接受凭证、在线状态或任意节点类型。
export function readBoardFile(value) {
  requireValid(
    record(value) && value.format === "flowboard" && value.version === 1,
    "请选择 Flowboard 导出的 v1 JSON 文件。",
  );
  requireValid(
    typeof value.title === "string" &&
      value.title.trim().length > 0 &&
      value.title.trim().length <= 40,
    "白板名称须为 1～40 字。",
  );
  requireValid(
    Array.isArray(value.nodes) && Array.isArray(value.edges),
    "文件缺少节点或连线数组。",
  );
  const nodeIds = new Set();
  const nodes = value.nodes.map((node) => {
    requireValid(
      record(node) && id(node.id) && !nodeIds.has(node.id),
      "节点 ID 无效或重复。",
    );
    requireValid(
      record(node.position) &&
        Number.isFinite(node.position.x) &&
        Number.isFinite(node.position.y),
      "节点坐标必须是有限数字。",
    );
    requireValid(
      record(node.data) &&
        typeof node.data.label === "string" &&
        typeof node.data.content === "string" &&
        colors.includes(node.data.color),
      "节点标题、正文或颜色无效。",
    );
    nodeIds.add(node.id);
    return {
      id: node.id,
      position: { x: node.position.x, y: node.position.y },
      data: {
        label: node.data.label,
        content: node.data.content,
        color: node.data.color,
      },
    };
  });
  const edgeIds = new Set();
  const edges = value.edges.map((edge) => {
    requireValid(
      record(edge) && id(edge.id) && !edgeIds.has(edge.id),
      "连线 ID 无效或重复。",
    );
    requireValid(
      nodeIds.has(edge.source) &&
        nodeIds.has(edge.target) &&
        edge.source !== edge.target,
      "连线引用了不存在的节点，或连接了节点自身。",
    );
    requireValid(
      edge.sourceHandle == null && edge.targetHandle == null,
      "文件包含当前卡片不支持的连接端点。",
    );
    edgeIds.add(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: null,
      targetHandle: null,
    };
  });
  return {
    format: "flowboard",
    version: 1,
    title: value.title.trim(),
    nodes,
    edges,
  };
}
