import { describe, expect, it } from 'vitest';
import { OVERRIDE_HEADER, parseFlagOverrides } from '../lib/flag-override.ts';

describe('the override header', () => {
  it('is named x-lab-flags', () => {
    expect(OVERRIDE_HEADER).toBe('x-lab-flags');
  });
});

describe('parseFlagOverrides', () => {
  it('reads "on" as true and "off" as false', () => {
    expect(parseFlagOverrides('show-discounts=on').get('show-discounts')).toBe(true);
    expect(parseFlagOverrides('show-discounts=off').get('show-discounts')).toBe(false);
  });

  it('reads several flags that a comma separates', () => {
    const overrides = parseFlagOverrides('show-discounts=on,new-menu=off');
    expect([...overrides]).toEqual([
      ['show-discounts', true],
      ['new-menu', false],
    ]);
  });

  it('accepts spaces around the parts and capital letters in the value', () => {
    expect(parseFlagOverrides(' show-discounts = ON , new-menu=Off ').size).toBe(2);
    expect(parseFlagOverrides(' show-discounts = ON ').get('show-discounts')).toBe(true);
  });

  it('lets the last value win when a flag appears twice', () => {
    expect(parseFlagOverrides('show-discounts=on,show-discounts=off').get('show-discounts')).toBe(false);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['text with no equals sign', 'show-discounts'],
    ['an empty value', 'show-discounts='],
    ['an empty name', '=on'],
    ['a value that is not on or off', 'show-discounts=yes'],
    ['a value of 1', 'show-discounts=1'],
    ['two equals signs', 'show-discounts==on'],
    ['a second equals sign in the value', 'show-discounts=on=off'],
    ['a name with a character outside the flag alphabet', 'show discounts=on'],
    ['a name that starts with an underscore', '__proto__=on'],
    ['only commas', ',,,'],
  ])('ignores %s', (_name, header) => {
    expect(parseFlagOverrides(header).size).toBe(0);
  });

  it('ignores a part that is malformed and keeps the parts that are right', () => {
    const overrides = parseFlagOverrides('garbage,show-discounts=on,new-menu=maybe');
    expect([...overrides]).toEqual([['show-discounts', true]]);
  });

  it('ignores a header that is far longer than any real one', () => {
    expect(parseFlagOverrides(`show-discounts=on,${'a=on,'.repeat(200)}`).size).toBe(0);
  });
});
