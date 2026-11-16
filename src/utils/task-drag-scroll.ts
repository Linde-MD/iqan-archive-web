export function taskDragScrollSpeed(pointerY: number, top: number, bottom: number): number {
  const edge = Math.min(48, (bottom - top) / 3);
  if (edge <= 0) return 0;
  if (pointerY < top + edge) return -640 * Math.min(1, (top + edge - pointerY) / edge);
  if (pointerY > bottom - edge) return 640 * Math.min(1, (pointerY - bottom + edge) / edge);
  return 0;
}

export function startTaskDragScroll(
  root: HTMLElement,
  position: () => { x: number; y: number },
): () => void {
  let frame = 0;
  let previousTime: number | undefined;
  const tick = (time: number) => {
    const elapsed = previousTime === undefined ? 0 : Math.min(32, time - previousTime);
    previousTime = time;
    const point = position();
    const rootBounds = root.getBoundingClientRect();
    for (const lane of root.querySelectorAll<HTMLElement>('.task-lane')) {
      const bounds = lane.getBoundingClientRect();
      if (point.x < Math.max(bounds.left, rootBounds.left, 0)
        || point.x > Math.min(bounds.right, rootBounds.right, window.innerWidth)
        || point.y < Math.max(bounds.top, 0) || point.y > Math.min(bounds.bottom, window.innerHeight)) continue;
      const list = lane.querySelector<HTMLElement>('.task-lane-list');
      if (!list) continue;
      const listBounds = list.getBoundingClientRect();
      const speed = taskDragScrollSpeed(point.y, Math.max(listBounds.top, 0), Math.min(listBounds.bottom, window.innerHeight));
      list.scrollTop += speed * elapsed / 1000;
      break;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
