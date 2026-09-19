import { describe, expect, it } from 'vitest';
import { buildMagicPacket, parseMacAddress } from './wol.js';

describe('wol', () => {
  it('parses MAC addresses and builds a magic packet', () => {
    expect(parseMacAddress('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(parseMacAddress('not-a-mac')).toBeNull();
    const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff');
    expect(packet).not.toBeNull();
    expect(packet!.length).toBe(102);
    expect(packet!.subarray(0, 6).equals(Buffer.alloc(6, 0xff))).toBe(true);
    expect(packet!.subarray(6, 12).equals(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))).toBe(
      true
    );
  });
});
