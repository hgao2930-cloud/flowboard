export function isRoomId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    !/[^A-Za-z0-9_-]/.test(value)
  )
}

// 路由入口与邀请链接共用；只允许一个房间号和可选的一个末尾斜杠。
export function roomIdFromPath(path: string): string | null {
  const match = /^\/board\/([^/]+)\/?$/.exec(path)
  if (!match?.[1] || match[0] !== path) return null
  try {
    const roomId = decodeURIComponent(match[1])
    return isRoomId(roomId) ? roomId : null
  } catch {
    return null
  }
}

export type JoinRoomResult = { roomId: string; error?: never } | { roomId?: never; error: string }

export function parseRoomInput(input: string, origin: string, base = '/'): JoinRoomResult {
  const value = input.trim()
  if (!value) return { error: '请输入房间号或本站的完整白板链接。' }
  if (isRoomId(value)) return { roomId: value }

  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      return { error: '请使用当前站点的 http 或 https 白板链接。' }
    }
    // URL 会折叠 ../ 等路径段；同时检查原始路径，避免把额外路径段当成合法邀请。
    const rawPath = /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:[?#]|$)/i.exec(value)?.[1]
    const roomId = rawPath?.startsWith(base) ? roomIdFromPath(rawPath.slice(base.length - 1)) : null
    if (
      roomId &&
      url.pathname.startsWith(base) &&
      roomIdFromPath(url.pathname.slice(base.length - 1)) === roomId
    )
      return { roomId }
    return { error: `白板链接路径应为 ${base}board/房间号，不能包含额外路径段或非法编码。` }
  } catch {
    return { error: '房间号须为 1～64 位字母、数字、短横线或下划线；也可粘贴本站完整白板链接。' }
  }
}
