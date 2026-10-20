import { describe, expect, it } from 'vitest';
import { redactSecretBytes, redactSecretValues } from '../src/redact.js';

describe('redaction by value', () => {
  it('replaces the secret in a text and keeps the rest intact', () => {
    const secret = 'ghp_livevalue0123456789ABCDEFGH';
    const text = `token=${secret} trailing`;
    expect(redactSecretValues(text, [secret])).toBe('token=[redacted] trailing');
  });

  it('replaces the JSON-escaped form of a secret, so the text stays valid JSON', () => {
    const secret = 'abc"def\\ghi';
    const json = JSON.stringify({ content: `the value is ${secret} here` });
    const redacted = redactSecretValues(json, [secret]);
    expect(redacted).not.toContain('abc');
    expect(redacted).toContain('[redacted]');
    expect(() => JSON.parse(redacted)).not.toThrow();
    expect(JSON.parse(redacted).content).toBe('the value is [redacted] here');
  });

  it('ignores values too short to be a secret', () => {
    expect(redactSecretValues('a b c', ['a'])).toBe('a b c');
  });

  it('redacts every occurrence of a secret', () => {
    const secret = 'ghp_livevalue0123456789ABCDEFGH';
    expect(redactSecretValues(`${secret} and ${secret}`, [secret])).toBe('[redacted] and [redacted]');
  });

  it('redacts bytes without touching a file that has no secret', () => {
    const secret = 'ghp_livevalue0123456789ABCDEFGH';
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    expect(redactSecretBytes(binary, [secret])).toBe(binary);
    const withSecret = Buffer.concat([binary, Buffer.from(secret)]);
    const redacted = redactSecretBytes(withSecret, [secret]);
    expect(new TextDecoder().decode(redacted)).not.toContain(secret);
    expect([...redacted.subarray(0, 6)]).toEqual([...binary]);
  });

  it('does not copy a buffer it did not change', () => {
    const bytes = Buffer.from('nothing secret here');
    expect(redactSecretBytes(bytes, ['ghp_livevalue0123456789ABCDEFGH'])).toBe(bytes);
  });
});
