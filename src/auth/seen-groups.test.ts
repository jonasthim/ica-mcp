import { describe, expect, it } from 'vitest';
import { createSeenGroups } from './seen-groups.js';

describe('createSeenGroups', () => {
  it('keeps every name (no prefix filter), deduplicated, at most 50, each at most 100 characters; undefined forgets', () => {
    const s = createSeenGroups();
    expect(s.get('u')).toBeUndefined();
    s.set('u', ['ica-hub-admins', 'admins', 'other-admins', 'admins', 'x'.repeat(101), 'y'.repeat(100)]);
    expect(s.get('u')).toEqual(['ica-hub-admins', 'admins', 'other-admins', 'y'.repeat(100)]);
    s.set('u', Array.from({ length: 70 }, (_, i) => `g${i}`));
    expect(s.get('u')).toHaveLength(50);
    s.set('u', []);
    expect(s.get('u')).toEqual([]); // known: none
    s.set('u', undefined);
    expect(s.get('u')).toBeUndefined();
  });
});
