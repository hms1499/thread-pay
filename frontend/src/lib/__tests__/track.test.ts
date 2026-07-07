import { describe, expect, it } from 'vitest';
import { backlinkVariant, parseThreadSlug, buildLanding } from '../track';

describe('backlinkVariant', () => {
  it('classifies a deep-link thread path as thread', () => {
    expect(backlinkVariant('/t/abc123')).toBe('thread');
  });

  it('classifies the homepage as home', () => {
    expect(backlinkVariant('/')).toBe('home');
  });

  it('classifies a bare /t (no slug) as home', () => {
    expect(backlinkVariant('/t')).toBe('home');
  });

  it('classifies other app paths as home', () => {
    expect(backlinkVariant('/history')).toBe('home');
  });
});

describe('parseThreadSlug', () => {
  it('extracts the slug from a /t/<slug> path', () => {
    expect(parseThreadSlug('/t/aB3-_xY')).toBe('aB3-_xY');
  });
  it('returns null for the homepage', () => {
    expect(parseThreadSlug('/')).toBeNull();
  });
  it('returns null for a bare /t/ with no slug', () => {
    expect(parseThreadSlug('/t/')).toBeNull();
  });
  it('returns null for a nested path under /t/', () => {
    expect(parseThreadSlug('/t/abc/extra')).toBeNull();
  });
});

describe('buildLanding', () => {
  it('records reach on a thread page regardless of ref marker', () => {
    expect(buildLanding('/t/abc', '')).toEqual({
      event: 'backlink_land', variant: 'thread', source_slug: 'abc',
    });
  });
  it('records intent with source_slug from ?src on a ref-marked home landing', () => {
    expect(buildLanding('/', '?ref=tg&src=abc')).toEqual({
      event: 'backlink_land', variant: 'home', source_slug: 'abc',
    });
  });
  it('records intent without source_slug when ?src is absent', () => {
    expect(buildLanding('/', '?ref=tg')).toEqual({
      event: 'backlink_land', variant: 'home',
    });
  });
  it('returns null on a home path with no ref marker', () => {
    expect(buildLanding('/', '')).toBeNull();
  });
});
