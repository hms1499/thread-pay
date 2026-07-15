import { describe, expect, it } from 'vitest';
import { CRAFT_GUIDE, ENDING_GUIDE } from '@/lib/generate-thread';
import { repurposeThreadService as s, buildRepurposeSystem } from '../repurpose-thread';

describe('repurpose-thread validate', () => {
  const ok = { sourceText: 'A long article about climate policy.', tone: 'educational', length: 8, language: 'en' };
  it('accepts well-formed input', () => {
    expect(s.validate(ok)).toEqual({ ok: true, params: { ...ok } });
  });
  it('rejects empty sourceText', () => {
    expect(s.validate({ ...ok, sourceText: '   ' })).toMatchObject({ ok: false });
  });
  it('rejects sourceText over 4000 chars', () => {
    expect(s.validate({ ...ok, sourceText: 'x'.repeat(4001) })).toMatchObject({ ok: false });
  });
  it('rejects a bad length', () => {
    expect(s.validate({ ...ok, length: 7 })).toMatchObject({ ok: false });
  });
  it('rejects a bad tone', () => {
    expect(s.validate({ ...ok, tone: 'aggressive' })).toMatchObject({ ok: false });
  });
  it('maps an unknown language to auto', () => {
    const r = s.validate({ ...ok, language: 'klingon' });
    expect(r.ok && r.params.language).toBe('auto');
  });
});

describe('repurpose-thread metadata + prompt', () => {
  it('is chained with a sourceText field', () => {
    expect(s.chained).toBe(true);
    expect(s.fields[0].name).toBe('sourceText');
  });
  it('prompt encodes the language instruction', () => {
    expect(buildRepurposeSystem(8, 'vi')).toContain('Vietnamese');
  });
});

describe('buildRepurposeSystem outline', () => {
  it('omits the outline instruction when none is given', () => {
    expect(buildRepurposeSystem(8, 'en')).not.toContain('Follow this outline');
  });

  it('appends the outline points in order when given', () => {
    const s = buildRepurposeSystem(8, 'en', ['First point', 'Second point']);
    expect(s).toContain('Follow this outline');
    expect(s).toContain('1. First point');
    expect(s).toContain('2. Second point');
  });
});

describe('buildRepurposeSystem craft rules', () => {
  it('includes the craft guide and the natural ending rule', () => {
    const system = buildRepurposeSystem(8, 'auto');
    expect(system).toContain(CRAFT_GUIDE);
    expect(system).toContain(ENDING_GUIDE);
    expect(system).not.toContain('takeaway or CTA');
  });
});
