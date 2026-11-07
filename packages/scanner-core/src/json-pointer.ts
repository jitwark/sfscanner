export function toJsonPointer(segments: Array<string | number>): string {
  return `/${segments.map((segment) => escapeJsonPointerSegment(String(segment))).join('/')}`;
}

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
