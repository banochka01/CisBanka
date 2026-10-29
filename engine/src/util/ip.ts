export function isValidIp(ip: string): boolean {
  const p = ip.split('.');
  return p.length === 4 && p.every((s) => /^\d{1,3}$/.test(s) && Number(s) <= 255);
}

export function ipToInt(ip: string): number {
  if (!isValidIp(ip)) throw new Error(`Некорректный IP-адрес: ${ip}`);
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Длина префикса или null, если маска не непрерывная (255.0.255.0). */
export function maskToPrefix(mask: string): number | null {
  if (!isValidIp(mask)) return null;
  const m = ipToInt(mask);
  const inv = ~m >>> 0;
  if ((inv & (inv + 1)) !== 0) return null;
  let n = 0;
  for (let x = m; x & 0x80000000; x = (x << 1) >>> 0) n++;
  return n;
}

export function prefixToMask(prefix: number): string {
  return intToIp(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
}

export function networkOf(ip: string, mask: string): string {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function broadcastOf(ip: string, mask: string): string {
  return intToIp((ipToInt(ip) | ~ipToInt(mask)) >>> 0);
}

export function inSubnet(ip: string, net: string, mask: string): boolean {
  const m = ipToInt(mask);
  return ((ipToInt(ip) & m) >>> 0) === ((ipToInt(net) & m) >>> 0);
}
