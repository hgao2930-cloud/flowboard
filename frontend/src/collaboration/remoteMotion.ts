type Point = { x: number; y: number }

// 仅平滑显示坐标，不接触 Y.Doc；目标改变时从当前显示位置重新出发。
export function createRemoteMotion(
  paint: (positions: Map<string, Point>) => void,
  clock = {
    now: () => performance.now(),
    request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    cancel: (id: number) => cancelAnimationFrame(id),
  },
) {
  const moves = new Map<string, { from: Point; to: Point; start: number }>()
  let frame: number | undefined
  function tick(now: number) {
    frame = undefined
    const positions = new Map<string, Point>()
    for (const [id, move] of moves) {
      const progress = Math.min(1, Math.max(0, (now - move.start) / 70))
      positions.set(id, {
        x: move.from.x + (move.to.x - move.from.x) * progress,
        y: move.from.y + (move.to.y - move.from.y) * progress,
      })
      if (progress === 1) moves.delete(id)
    }
    paint(positions)
    if (moves.size) frame = clock.request(tick)
  }
  function remove(id: string) {
    moves.delete(id)
    if (!moves.size && frame !== undefined) {
      clock.cancel(frame)
      frame = undefined
    }
  }
  return {
    move(id: string, from: Point, to: Point) {
      const previous = moves.get(id)
      if (previous?.to.x === to.x && previous.to.y === to.y) return
      if (from.x === to.x && from.y === to.y) return remove(id)
      moves.set(id, { from: { ...from }, to: { ...to }, start: clock.now() })
      if (frame === undefined) frame = clock.request(tick)
    },
    remove,
    retain(ids: Set<string>) {
      for (const id of moves.keys()) if (!ids.has(id)) remove(id)
    },
    clear() {
      moves.clear()
      if (frame !== undefined) clock.cancel(frame)
      frame = undefined
    },
  }
}
