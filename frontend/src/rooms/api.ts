// Node 直接运行的单元测试没有 Vite 环境变量，默认使用开发环境根路径。
const roomsUrl = `${import.meta.env?.BASE_URL ?? '/'}api/rooms`
import type { BoardFile } from '../../../shared/boardFile.mjs'

export interface Room {
  id: string
  title: string
  createdAt: number
  saveState?: 'saved' | 'pending' | 'error' | 'too_large'
  savedAt?: number
}
export interface CreatedRoom extends Room {
  managementToken: string
}
export class RoomApiError extends Error {
  status: number
  saveState?: 'error' | 'too_large'
  constructor(message: string, status: number, saveState?: unknown) {
    super(message)
    this.status = status
    if (saveState === 'error' || saveState === 'too_large') this.saveState = saveState
  }
}

async function requestRoom(path: string, options?: RequestInit): Promise<Room> {
  let response: Response
  try {
    response = await fetch(path, { ...options, signal: AbortSignal.timeout(8000) })
  } catch {
    throw new Error('无法连接房间服务，请检查网络或确认后端已启动。')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new RoomApiError(
      body?.message || '房间服务暂时不可用，请稍后重试。',
      response.status,
      body?.saveState,
    )
  }
  if (response.status === 204) return body
  if (typeof body?.id !== 'string' || typeof body?.title !== 'string') {
    throw new Error('房间服务返回的数据不完整，请稍后重试。')
  }
  return body
}

export async function createRoom(title: string, imported?: BoardFile): Promise<CreatedRoom> {
  const room = await requestRoom(imported ? `${roomsUrl}/import` : roomsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(imported ?? { title }),
  })
  const created = room as CreatedRoom
  if (
    typeof created.managementToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(created.managementToken)
  ) {
    throw new Error('创建响应缺少管理凭证，请勿将此操作视为完整成功。')
  }
  return created
}

export async function deleteRoom(roomId: string, token: string): Promise<void> {
  await requestRoom(`${roomsUrl}/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    headers: { 'X-Room-Management-Token': token },
  })
}

export async function retryRoomSave(roomId: string): Promise<void> {
  // 保存接口返回保存状态，不返回 Room，统一的查询随后取得完整反馈。
  let response: Response
  try {
    response = await fetch(`${roomsUrl}/${encodeURIComponent(roomId)}/save`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    throw new Error('无法连接房间服务，请稍后重试保存。')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new RoomApiError(
      body?.message || '保存未成功，请稍后重试。',
      response.status,
      body?.saveState,
    )
  }
}

export function getRoom(roomId: string) {
  return requestRoom(`${roomsUrl}/${encodeURIComponent(roomId)}`)
}
