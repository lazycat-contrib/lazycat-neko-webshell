export function floatingViewportBounds(margin: number) {
  const viewport = window.visualViewport;
  const offsetLeft = Math.max(0, Math.floor(viewport?.offsetLeft ?? 0));
  const offsetTop = Math.max(0, Math.floor(viewport?.offsetTop ?? 0));
  const width = Math.max(1, Math.floor(viewport?.width ?? (window.innerWidth || 0)));
  const height = Math.max(1, Math.floor(viewport?.height ?? (window.innerHeight || 0)));
  return {
    minLeft: offsetLeft + margin,
    minTop: offsetTop + margin,
    maxLeft: offsetLeft + width - margin,
    maxTop: offsetTop + height - margin,
  };
}

export function clampFloatingPoint(
  clientX: number,
  clientY: number,
  options: { width?: number; height?: number; margin?: number } = {},
) {
  const bounds = floatingViewportBounds(options.margin ?? 8);
  const width = Math.max(0, options.width ?? 0);
  const height = Math.max(0, options.height ?? 0);
  const maxLeft = Math.max(bounds.minLeft, bounds.maxLeft - width);
  const maxTop = Math.max(bounds.minTop, bounds.maxTop - height);
  return {
    x: clamp(clientX, bounds.minLeft, maxLeft),
    y: clamp(clientY, bounds.minTop, maxTop),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
