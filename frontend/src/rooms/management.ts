import { isRoomId } from './roomId.ts'

const prefix = 'flowboard.management.v1.'
const temporary = new Map<string, string>()
const unsaved = new Set<string>()
type CredentialStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const CREDENTIAL_NOTICE =
  '管理凭证未能持久保存。当前页面仍可管理；关闭、刷新或清理浏览器数据后可能永久失去管理权。'

export function saveManagementToken(
  roomId: string,
  token: string,
  storage?: CredentialStorage,
): boolean {
  if (!isRoomId(roomId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
  temporary.set(roomId, token)
  try {
    const target = storage ?? window.localStorage
    target.setItem(prefix + roomId, token)
    unsaved.delete(roomId)
    return true
  } catch {
    unsaved.add(roomId)
    return false
  }
}
export function readManagementToken(roomId: string, storage?: CredentialStorage): string | null {
  if (!isRoomId(roomId)) return null
  if (temporary.has(roomId)) return temporary.get(roomId)!
  try {
    const token = (storage ?? window.localStorage).getItem(prefix + roomId)
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  } catch {
    return null
  }
}
export function isManagementTokenTemporary(roomId: string) {
  return unsaved.has(roomId)
}
export function removeManagementToken(roomId: string, storage?: CredentialStorage): boolean {
  temporary.delete(roomId)
  unsaved.delete(roomId)
  try {
    ;(storage ?? window.localStorage).removeItem(prefix + roomId)
    return true
  } catch {
    return false
  }
}
