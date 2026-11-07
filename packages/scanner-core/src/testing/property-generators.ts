export type PropertyRng = Readonly<{
  nextUint32: () => number;
  integer: (exclusiveMaximum: number) => number;
}>;

export type UnicodeCase = Readonly<{ text: string }>;
export type WorkflowCase = Readonly<{ canonical: string; permuted: string }>;
export type CanonicalValueCase = Readonly<{
  value: Record<string, unknown>;
  permuted: Record<string, unknown>;
  arrayPermuted: Record<string, unknown>;
}>;
export type RedactionCase = Readonly<{ value: Record<string, unknown> }>;
export type BudgetCase = Readonly<{ maximum: number; units: number }>;

const encoder = new TextEncoder();

export function createPropertyRng(seed: number): PropertyRng {
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer');
  let state = (seed >>> 0) || 0x9e3779b9;
  const nextUint32 = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const integer = (exclusiveMaximum: number): number => {
    if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum < 1) {
      throw new TypeError('exclusiveMaximum must be a positive safe integer');
    }
    return nextUint32() % exclusiveMaximum;
  };
  return Object.freeze({ nextUint32, integer });
}

export function malformedByteCases(seed: number, count: number): readonly Uint8Array[] {
  const rng = createPropertyRng(seed);
  const cases: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) {
      const bytes = new Uint8Array(1 + rng.integer(24));
      bytes[0] = 0xff;
      for (let offset = 1; offset < bytes.length; offset += 1) bytes[offset] = rng.nextUint32() & 0xff;
      cases.push(bytes);
      continue;
    }
    const node = `{"id":"n${rng.integer(1000)}","name":"N","type":"@example/property"}`;
    cases.push(encoder.encode(`{"nodes":[${node}`));
  }
  return Object.freeze(cases);
}

export function unicodeCases(seed: number, count: number): readonly UnicodeCase[] {
  const rng = createPropertyRng(seed);
  const values = ['é', '🚀', '漢字', 'e\u0301', '🙂'] as const;
  const cases: UnicodeCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = values[rng.integer(values.length)];
    cases.push(Object.freeze({ text: `{"name":${JSON.stringify(value)},"value":"v${index}"}` }));
  }
  return Object.freeze(cases);
}

export function workflowCases(seed: number, count: number): readonly WorkflowCase[] {
  const rng = createPropertyRng(seed);
  const cases: WorkflowCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const nodes = Array.from({ length: rng.integer(3) }, (_, nodeIndex) => ({
      id: `node-${index}-${nodeIndex}`,
      name: `Node ${nodeIndex}`,
      type: '@example/property-node',
      parameters: { message: `v${rng.integer(1000)}`, enabled: nodeIndex % 2 === 0 },
    }));
    cases.push(Object.freeze({
      canonical: JSON.stringify({ nodes, connections: {} }),
      permuted: JSON.stringify({ connections: {}, nodes }),
    }));
  }
  return Object.freeze(cases);
}

function permuteRecord(record: Record<string, unknown>, rng: PropertyRng): Record<string, unknown> {
  const keys = Object.keys(record);
  for (let index = keys.length - 1; index > 0; index -= 1) {
    const swap = rng.integer(index + 1);
    [keys[index], keys[swap]] = [keys[swap], keys[index]];
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) output[key] = record[key];
  return output;
}

export function canonicalValueCases(seed: number, count: number): readonly CanonicalValueCase[] {
  const rng = createPropertyRng(seed);
  const cases: CanonicalValueCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = {
      zeta: index,
      alpha: `value-${rng.integer(1000)}`,
      nested: { beta: index % 3, gamma: `g-${rng.integer(1000)}` },
      items: [index, index + 1, index + 2],
    };
    cases.push(Object.freeze({
      value,
      permuted: permuteRecord(value, rng),
      arrayPermuted: { ...value, items: [index + 2, index + 1, index] },
    }));
  }
  return Object.freeze(cases);
}

export function redactionCases(seed: number, count: number): readonly RedactionCase[] {
  const rng = createPropertyRng(seed);
  const cases: RedactionCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const token = `private-token-${rng.nextUint32().toString(16)}`;
    cases.push(Object.freeze({ value: {
      label: `case-${index}`,
      apiKey: token,
      nested: { password: `password-${index}`, safe: `safe-${index}` },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      text: `token=${token}`,
    } }));
  }
  return Object.freeze(cases);
}

export function budgetCases(seed: number, count: number): readonly BudgetCase[] {
  const rng = createPropertyRng(seed);
  const cases: BudgetCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const maximum = 1 + rng.integer(8);
    cases.push(Object.freeze({ maximum, units: 1 + rng.integer(maximum) }));
  }
  return Object.freeze(cases);
}
