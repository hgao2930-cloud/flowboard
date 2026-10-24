import { isRoomId } from './roomId.ts'

export const RECENT_BOARDS_KEY = 'flowboard.recentBoards.v1'
export const RECENT_BOARDS_LIMIT = 20
export const LOCAL_NAME_LIMIT = 40
export const STORAGE_NOTICE = '最近访问记录无法保存在此浏览器，仍可正常进入白板。'

export interface RecentBoard {
  roomId: string
  localName?: string
  lastVisitedAt: number
}

type BoardStorage = Pick<Storage, 'getItem' | 'setItem'>
interface StorageResult {
  boards: RecentBoard[]
  storageUnavailable: boolean
}

export function organizeRecentBoards(value: unknown): RecentBoard[] {
  if (!Array.isArray(value)) return []
  const valid: RecentBoard[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { roomId, localName, lastVisitedAt } = entry
    if (!isRoomId(roomId)) continue
    if (
      localName !== undefined &&
      (typeof localName !== 'string' || localName.length > LOCAL_NAME_LIMIT)
    )
      continue
    if (
      typeof lastVisitedAt !== 'number' ||
      !Number.isSafeInteger(lastVisitedAt) ||
      lastVisitedAt < 0 ||
      lastVisitedAt > 8.64e15
    )
      continue
    const name = typeof localName === 'string' ? localName.trim() : ''
    valid.push({ roomId, ...(name ? { localName: name } : {}), lastVisitedAt })
  }
  valid.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
  const unique = new Map<string, RecentBoard>()
  for (const board of valid) {
    const existing = unique.get(board.roomId)
    if (!existing) unique.set(board.roomId, board)
    else if (!existing.localName && board.localName) existing.localName = board.localName
  }
  return [...unique.values()].slice(0, RECENT_BOARDS_LIMIT)
}

export function readRecentBoards(storage?: BoardStorage): StorageResult {
  let raw: string | null
  try {
    raw = (storage ?? window.localStorage).getItem(RECENT_BOARDS_KEY)
  } catch {
    return { boards: [], storageUnavailable: true }
  }
  try {
    return {
      boards: organizeRecentBoards(raw === null ? [] : JSON.parse(raw)),
      storageUnavailable: false,
    }
  } catch {
    // 损坏的 JSON 与浏览器拒绝存储不同；下次成功访问时会写回干净的记录。
    return { boards: [], storageUnavailable: false }
  }
}

function writeRecentBoards(boards: RecentBoard[], storage?: BoardStorage): StorageResult {
  try {
    const target = storage ?? window.localStorage
    target.setItem(RECENT_BOARDS_KEY, JSON.stringify(boards))
    return { boards, storageUnavailable: false }
  } catch {
    return { boards, storageUnavailable: true }
  }
}

export function recordBoardVisit(
  roomId: string,
  localName?: string,
  storage?: BoardStorage,
  lastVisitedAt = Date.now(),
): StorageResult {
  const result = readRecentBoards(storage)
  if (result.storageUnavailable) return result
  const existing = result.boards.find((board) => board.roomId === roomId)
  const boards = organizeRecentBoards([
    ...result.boards.filter((board) => board.roomId !== roomId),
    { roomId, localName: existing?.localName ?? localName, lastVisitedAt },
  ])
  return writeRecentBoards(boards, storage)
}

export function removeRecentBoard(roomId: string, storage?: BoardStorage): StorageResult {
  const result = readRecentBoards(storage)
  if (result.storageUnavailable) return result
  return writeRecentBoards(
    result.boards.filter((board) => board.roomId !== roomId),
    storage,
  )
}
