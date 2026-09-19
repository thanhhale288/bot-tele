/**
 * Wake-on-LAN magic packet (Phase 7.5, optional).
 */

import { createSocket } from 'dgram';

const MAC_RE = /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i;

export function parseMacAddress(input: string): string | null {
  const match = input.trim().match(MAC_RE);
  if (!match) return null;
  return match
    .slice(1, 7)
    .map((octet) => octet.toLowerCase())
    .join(':');
}

export function buildMagicPacket(mac: string): Buffer | null {
  const parsed = parseMacAddress(mac);
  if (!parsed) return null;
  const octets = parsed.split(':').map((part) => Number.parseInt(part, 16));
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = octets[j]!;
    }
  }
  return packet;
}

export async function sendWakeOnLan(
  mac: string,
  broadcast = '255.255.255.255',
  port = 9
): Promise<{ ok: boolean; message: string }> {
  const packet = buildMagicPacket(mac);
  if (!packet) {
    return { ok: false, message: 'Invalid MAC address. Use aa:bb:cc:dd:ee:ff' };
  }

  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      resolve({ ok: false, message: err.message });
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, 0, packet.length, port, broadcast, (err) => {
          socket.close();
          if (err) {
            resolve({ ok: false, message: err.message });
            return;
          }
          resolve({
            ok: true,
            message: `Wake-on-LAN packet sent to ${parseMacAddress(mac)} (${broadcast}:${port}).`,
          });
        });
      } catch (err) {
        socket.close();
        resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  });
}
