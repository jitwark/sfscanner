import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import {
  buildRedistributableBodyInventory,
  type BodyInventoryRow,
} from './redistributable-body-inventory.js';

const DATA_DIR = path.join(process.cwd(), 'data');

/** The committed corpus's same shard-glob convention: stop at the first gap. */
function readCatalogueEntries(dataDir: string): Entry[] {
  const entries: Entry[] = [];
  for (let shard = 0; ; shard += 1) {
    const shardPath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(shardPath)) return entries;
    entries.push(...(JSON.parse(fs.readFileSync(shardPath, 'utf8')) as Entry[]));
  }
}

function sortedCopy(rows: readonly BodyInventoryRow[]): BodyInventoryRow[] {
  return [...rows].sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line,
  );
}

describe('buildRedistributableBodyInventory', () => {
  /**
   * Audit F-001 RULING-2 moved the corpus's 288 redistributable rows to
   * link-only and cleared their `download` pointers, and P3-3 then removed the
   * pack files, so the corpus that ships today reconciles to no bodies at all.
   * The invariant is therefore stated against the corpus's own pointers rather
   * than a remembered total, and holds at any count — including the 288 it used
   * to hold and the 0 it holds now.
   */
  it('reconciles the real corpus to the bodies still carrying a download pointer, sorted by pack then line', () => {
    const entries = readCatalogueEntries(DATA_DIR);
    const inventory = buildRedistributableBodyInventory(entries, DATA_DIR);
    const withDownload = entries.filter(
      (entry) => entry.rights?.status === 'redistributable' && entry.download !== undefined,
    );

    expect(entries.length).toBeGreaterThan(0);
    expect(inventory.count).toBe(withDownload.length);
    expect(inventory.rows).toHaveLength(withDownload.length);
    expect(inventory.totalBytes).toBe(inventory.rows.reduce((sum, row) => sum + row.bytes, 0));
    expect(inventory.rows).toEqual(sortedCopy(inventory.rows));
    for (const row of inventory.rows) {
      expect(row.path).toMatch(/^packs\/pack-\d+\.jsonl$/);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.bytes).toBeGreaterThan(0);
    }
  });

  it('orders a two-pack inventory by pack then line and reports each packed record', () => {
    const dir = path.join(process.cwd(), 'pipeline', '.work', 'hub-corpus-inventory-multi-pack');
    // Three records over two packs, laid out in (pack, line) order for writing;
    // the entries are then handed to the builder in reverse, so the returned
    // ordering can only come from the builder's sort.
    const packed: Array<{ pack: number; line: number; record: string }> = [
      { pack: 0, line: 0, record: '{"nodes":[]}' },
      { pack: 0, line: 1, record: '{"nodes":[{"name":"a"}]}' },
      { pack: 1, line: 0, record: '{"id":"x"}' },
    ];
    const hashOf = (record: string) =>
      crypto.createHash('sha256').update(record, 'utf8').digest('hex');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
    const packText = [0, 1]
      .map((pack) => {
        const lines = packed.filter((p) => p.pack === pack).map((p) => p.record);
        const text = `${lines.join('\n')}\n`;
        fs.writeFileSync(path.join(dir, 'packs', `pack-${pack}.jsonl`), text, 'utf8');
        return text;
      })
      .join('');

    const offsets = new Map<number, number>();
    const entries = packed.map(({ pack, line, record }) => {
      const offset = offsets.get(pack) ?? 0;
      offsets.set(pack, offset + Buffer.byteLength(record, 'utf8') + 1);
      const entry = makeEntry({
        id: `pack-${pack}-line-${line}`,
        rights: { status: 'redistributable' },
      });
      // `download.length` spans the record's JSONL newline, while `bytes` and
      // `sha256` describe the record alone — the split the builder asserts.
      entry.download = {
        pack,
        line,
        offset,
        length: Buffer.byteLength(`${record}\n`, 'utf8'),
        sha256: hashOf(record),
      };
      return entry;
    });

    try {
      const inventory = buildRedistributableBodyInventory([...entries].reverse(), dir);

      expect(inventory.count).toBe(3);
      expect(inventory.rows.map((row) => [row.path, row.line])).toEqual([
        ['packs/pack-0.jsonl', 0],
        ['packs/pack-0.jsonl', 1],
        ['packs/pack-1.jsonl', 0],
      ]);
      expect(inventory.rows).toEqual(sortedCopy(inventory.rows));
      expect(inventory.rows.map((row) => row.bytes)).toEqual([
        Buffer.byteLength('{"nodes":[]}', 'utf8'),
        Buffer.byteLength('{"nodes":[{"name":"a"}]}', 'utf8'),
        Buffer.byteLength('{"id":"x"}', 'utf8'),
      ]);
      expect(inventory.rows.map((row) => row.sha256)).toEqual([
        hashOf('{"nodes":[]}'),
        hashOf('{"nodes":[{"name":"a"}]}'),
        hashOf('{"id":"x"}'),
      ]);
      // Every packed byte except the three record terminators.
      expect(inventory.totalBytes).toBe(Buffer.byteLength(packText, 'utf8') - packed.length);
      for (const row of inventory.rows) {
        expect(row.path).toMatch(/^packs\/pack-\d+\.jsonl$/);
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row.bytes).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads bytes rather than trusting a remembered count', () => {
    const entries = readCatalogueEntries(DATA_DIR);
    const inventory = buildRedistributableBodyInventory(entries.slice(0, 3), DATA_DIR);
    // The first three committed entries are redistributable and still carry bodies.
    const withBodies = entries.slice(0, 3).filter((entry) => entry.download !== undefined);
    expect(inventory.count).toBe(withBodies.length);
  });

  it('rejects a body whose catalogue byte range disagrees with the packed record', () => {
    const entry = makeEntry({ id: 'range-mismatch', rights: { status: 'redistributable' } }) as Entry;
    entry.download = { pack: 0, line: 0, offset: 0, length: 9_999, sha256: 'a'.repeat(64) };
    const dir = path.join(process.cwd(), 'pipeline', '.work', 'hub-corpus-residual-inventory-test');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packs', 'pack-0.jsonl'), '{"nodes":[]}\n', 'utf8');
    try {
      expect(() => buildRedistributableBodyInventory([entry], dir)).toThrow(/range is 9999/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a body whose recomputed hash disagrees with the catalogue', () => {
    const entry = makeEntry({ id: 'hash-mismatch', rights: { status: 'redistributable' } }) as Entry;
    const record = '{"nodes":[]}';
    entry.download = { pack: 0, line: 0, offset: 0, length: Buffer.byteLength(`${record}\n`, 'utf8'), sha256: 'a'.repeat(64) };
    const dir = path.join(process.cwd(), 'pipeline', '.work', 'hub-corpus-residual-inventory-test');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packs', 'pack-0.jsonl'), `${record}\n`, 'utf8');
    try {
      expect(() => buildRedistributableBodyInventory([entry], dir)).toThrow(/SHA-256 mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
