import { describe, expect, it } from 'vitest';
import { normaliseNigerianMobile } from '../../../../src/modules/auth/phone.js';

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

describe('normaliseNigerianMobile', () => {
  it.each([
    ['+2348012345678', '+2348012345678'],
    ['2348012345678', '+2348012345678'],
    ['08012345678', '+2348012345678'],
    ['07012345678', '+2347012345678'],
    ['08112345678', '+2348112345678'],
    ['09012345678', '+2349012345678'],
    ['09112345678', '+2349112345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseNigerianMobile(input)).toBe(expected);
  });

  it.each([
    '+234 801 234 5678',
    '+234-801-234-5678',
    '(0801) 234 5678',
    ' 0801 234 5678 ',
    '0801\t234\t5678',
  ])('ignores separators in %j', (input) => {
    expect(normaliseNigerianMobile(input)).toBe('+2348012345678');
  });

  it('returns a value the users table E.164 check accepts', () => {
    expect(normaliseNigerianMobile('08012345678')).toMatch(E164_PATTERN);
  });

  it.each([
    ['empty input', ''],
    ['only separators', ' - ( ) '],
    ['Lagos landline', '012345678'],
    ['landline with country code', '+23412345678'],
    ['unknown mobile prefix 06', '06012345678'],
    ['unknown mobile prefix 071', '07112345678'],
    ['unknown mobile prefix 082', '08212345678'],
    ['unknown mobile prefix 092', '09212345678'],
    ['too short', '0801234567'],
    ['too long', '080123456789'],
    ['too long with country code', '+23480123456789'],
    ['trunk zero after country code', '+2340801234567'],
    ['trunk zero after country code, full length', '+23408012345678'],
    ['another country code', '+447912345678'],
    ['missing leading zero', '8012345678'],
    ['double plus', '++2348012345678'],
    ['plus in the middle', '234+8012345678'],
    ['letters', '0801234567a'],
    ['dots as separators', '0801.234.5678'],
    ['non-ASCII digits', '٠٨٠١٢٣٤٥٦٧٨'],
  ])('rejects %s', (_label, input) => {
    expect(normaliseNigerianMobile(input)).toBeNull();
  });
});
