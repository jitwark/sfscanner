export function exceedsNestingDepth(value: unknown, maxDepth: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > maxDepth) return current !== undefined;
    if (!isContainer(current.value) || visited.has(current.value)) continue;

    visited.add(current.value);
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  return false;
}

export function exceedsParameterBudget(
  value: unknown,
  limits: { maxDepth?: number; maxLeaves?: number },
): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let leaves = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (limits.maxDepth !== undefined && current.depth > limits.maxDepth) return true;
    if (!isContainer(current.value)) {
      leaves += 1;
      if (limits.maxLeaves !== undefined && leaves > limits.maxLeaves) return true;
      continue;
    }
    if (visited.has(current.value)) continue;

    visited.add(current.value);
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  return false;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}
