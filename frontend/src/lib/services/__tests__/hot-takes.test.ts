import { describe, expect, it } from 'vitest';
import { CRAFT_GUIDE } from '@/lib/generate-thread';
import { hotTakesService as s, buildHotTakesSystem } from '../hot-takes';

describe('hot-takes validate', () => {
  const ok = { topic: 'remote work', tone: 'threadboi', count: 5, language: 'en' };
  it('accepts well-formed input', () => {
    expect(s.validate(ok)).toEqual({ ok: true, params: { ...ok } });
  });
  it('rejects count outside {3,5,8}', () => {
    expect(s.validate({ ...ok, count: 4 })).toMatchObject({ ok: false });
  });
  it('rejects empty topic', () => {
    expect(s.validate({ ...ok, topic: '' })).toMatchObject({ ok: false });
  });
});

describe('hot-takes metadata + prompt', () => {
  it('is NOT chained', () => {
    expect(s.chained).toBe(false);
    expect(s.id).toBe('hot-takes');
  });
  it('has a count field with 3/5/8', () => {
    const f = s.fields.find((x) => x.name === 'count');
    expect(f && f.type === 'number' && f.options).toEqual([3, 5, 8]);
  });
  it('prompt asks for N standalone posts', () => {
    expect(buildHotTakesSystem(5, 'en')).toMatch(/standalone/i);
  });
});

describe('buildHotTakesSystem craft rules', () => {
  it('includes the shared craft guide', () => {
    expect(buildHotTakesSystem(5, 'auto')).toContain(CRAFT_GUIDE);
  });
});
