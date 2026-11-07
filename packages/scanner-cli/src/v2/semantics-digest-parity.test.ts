import { describe, expect, it } from 'vitest';
import { SEMANTIC_CATALOGUE_DIGEST_V2 as coreDigest } from '@hub/scanner-core/v2';
import { SEMANTIC_CATALOGUE_DIGEST_V2 as cliDigest } from './contracts';

describe('CLI semantic catalogue authority', () => {
  it('pins the live scanner-core catalogue digest', () => {
    expect(cliDigest).toBe(coreDigest);
  });
});
