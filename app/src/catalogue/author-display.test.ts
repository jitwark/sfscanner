import { describe, expect, it } from 'vitest';
import { authorDisplayName, isRedactedAuthorName, publishableAuthorName } from './author-display';

describe('authorDisplayName', () => {
  it('does not present the marker as a name when no real characters remain', () => {
    expect(authorDisplayName('[email]')).toBe('Author contact withheld');
    expect(authorDisplayName('"[email]"')).toBe('Author contact withheld');
    expect(authorDisplayName('[email]\u200B')).toBe('Author contact withheld');
  });

  it('keeps non-email display text and marks mixed names as redacted', () => {
    expect(authorDisplayName('Alice <[email]>')).toBe('Alice <[email]>');
    expect(authorDisplayName('Alice Developer')).toBe('Alice Developer');
    expect(authorDisplayName(undefined)).toBe('Unknown');
    expect(isRedactedAuthorName('Alice <[email]>')).toBe(true);
    expect(isRedactedAuthorName('Alice Developer')).toBe(false);
  });

  it('publishes a structured-data author only when the name is not redacted', () => {
    expect(publishableAuthorName('Alice Developer')).toBe('Alice Developer');
    expect(publishableAuthorName('Alice <[email]>')).toBeUndefined();
    expect(publishableAuthorName('[email]')).toBeUndefined();
  });
});
