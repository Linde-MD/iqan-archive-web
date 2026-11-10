export interface ViewportPoint {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export function placeContextMenu(
  anchor: ViewportPoint,
  element: ViewportSize,
  viewport: ViewportSize,
  inset = 8,
  gap = 4,
): ViewportPoint {
  const maximumX = Math.max(inset, viewport.width - element.width - inset);
  const maximumY = Math.max(inset, viewport.height - element.height - inset);
  const belowFits = anchor.y + gap + element.height <= viewport.height - inset;
  const aboveY = anchor.y - gap - element.height;
  const aboveFits = aboveY >= inset;
  const rightFits = anchor.x + gap + element.width <= viewport.width - inset;
  const leftX = anchor.x - gap - element.width;
  const leftFits = leftX >= inset;

  return {
    x: rightFits ? anchor.x + gap : leftFits ? leftX : Math.max(inset, Math.min(anchor.x, maximumX)),
    y: belowFits ? anchor.y + gap : aboveFits ? aboveY : Math.max(inset, Math.min(anchor.y, maximumY)),
  };
}