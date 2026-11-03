# Независимая эталонная сборка пакетов (struct + своя контрольная сумма) для тестов кодеков.
import struct, json

def csum(b):
    if len(b) % 2: b += b'\0'
    s = sum(struct.unpack('!%dH' % (len(b)//2), b))
    while s >> 16: s = (s & 0xffff) + (s >> 16)
    return (~s) & 0xffff

def ip(s): return bytes(int(x) for x in s.split('.'))
def mac(s): return bytes.fromhex(s.replace('.', ''))

def eth(dst, src, et, payload, vlan=None):
    h = mac(dst) + mac(src)
    if vlan is not None: h += struct.pack('!HH', 0x8100, vlan)
    f = h + struct.pack('!H', et) + payload
    return f + b'\0' * max(0, 60 - len(f))

def ipv4(src, dst, ttl, proto, ident, payload, df=False):
    h = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(payload), ident, 0x4000 if df else 0, ttl, proto, 0, ip(src), ip(dst))
    h = h[:10] + struct.pack('!H', csum(h)) + h[12:]
    return h + payload

def pseudo(src, dst, proto, ln): return ip(src) + ip(dst) + struct.pack('!BBH', 0, proto, ln)

def udp(src, dst, sp, dp, payload):
    ln = 8 + len(payload)
    h = struct.pack('!HHHH', sp, dp, ln, 0) + payload
    c = csum(pseudo(src, dst, 17, ln) + h) or 0xffff
    return h[:6] + struct.pack('!H', c) + h[8:]

def tcp(src, dst, sp, dp, seq, ack, flags, win, mss=None, payload=b''):
    opts = struct.pack('!BBH', 2, 4, mss) if mss else b''
    hl = 20 + len(opts)
    h = struct.pack('!HHIIBBHHH', sp, dp, seq, ack, (hl // 4) << 4, flags, win, 0, 0) + opts + payload
    c = csum(pseudo(src, dst, 6, len(h)) + h)
    return h[:16] + struct.pack('!H', c) + h[18:]

def icmp_echo(t, ident, seq):
    data = b'abcdefghijklmnopqrstuvwabcdefghi'
    h = struct.pack('!BBHHH', t, 0, 0, ident, seq) + data
    return h[:2] + struct.pack('!H', csum(h)) + h[4:]

def icmp_err(t, code, quoted):
    h = struct.pack('!BBHI', t, code, 0, 0) + quoted
    return h[:2] + struct.pack('!H', csum(h)) + h[4:]

A = '0060.5C3A.1B01'; B = '0060.5C3A.1B02'; BC = 'FFFF.FFFF.FFFF'
out = {}
out['arp_request'] = eth(BC, A, 0x0806, struct.pack('!HHBBH6s4s6s4s', 1, 0x0800, 6, 4, 1, mac(A), ip('192.168.1.10'), bytes(6), ip('192.168.1.20')))
out['arp_reply_vlan'] = eth(A, B, 0x0806, struct.pack('!HHBBH6s4s6s4s', 1, 0x0800, 6, 4, 2, mac(B), ip('192.168.1.20'), mac(A), ip('192.168.1.10')), vlan=10)
out['icmp_echo_request'] = eth(B, A, 0x0800, ipv4('192.168.1.10', '192.168.1.20', 128, 1, 7, icmp_echo(8, 0x1234, 1)))
orig = ipv4('192.168.1.10', '10.0.0.1', 1, 1, 9, icmp_echo(8, 5, 1))
out['icmp_time_exceeded'] = eth(A, B, 0x0800, ipv4('192.168.1.1', '192.168.1.10', 255, 1, 3, icmp_err(11, 0, orig[:28])))
dnsq = struct.pack('!HHHHHH', 0x002a, 0x0100, 1, 0, 0, 0) + b'\x04site\x05local\x00' + struct.pack('!HH', 1, 1)
out['dns_query'] = eth(B, A, 0x0800, ipv4('192.168.1.10', '192.168.1.2', 128, 17, 11, udp('192.168.1.10', '192.168.1.2', 1066, 53, dnsq)))
dnsr = struct.pack('!HHHHHH', 0x002a, 0x8180, 1, 1, 0, 0) + b'\x04site\x05local\x00' + struct.pack('!HH', 1, 1) + struct.pack('!HHHIH', 0xc00c, 1, 1, 86400, 4) + ip('192.168.1.2')
out['dns_response'] = eth(A, B, 0x0800, ipv4('192.168.1.2', '192.168.1.10', 128, 17, 12, udp('192.168.1.2', '192.168.1.10', 53, 1066, dnsr)))
boot = struct.pack('!BBBBIHH4s4s4s4s16s64s128sI', 1, 1, 6, 0, 0xdeadbeef, 0, 0x8000, bytes(4), bytes(4), bytes(4), bytes(4), mac(A) + bytes(10), bytes(64), bytes(128), 0x63825363)
boot += bytes([53, 1, 1, 55, 3, 1, 3, 6, 255])
boot += bytes(300 - len(boot))
out['dhcp_discover'] = eth(BC, A, 0x0800, ipv4('0.0.0.0', '255.255.255.255', 128, 17, 1, udp('0.0.0.0', '255.255.255.255', 68, 67, boot)))
out['tcp_syn'] = eth(B, A, 0x0800, ipv4('192.168.1.10', '192.168.1.2', 128, 6, 20, tcp('192.168.1.10', '192.168.1.2', 49200, 80, 2197249643, 0, 0x02, 64240, mss=1460), df=True))
get = b'GET / HTTP/1.1\r\nHost: site.local\r\nUser-Agent: CisBanka/1.0\r\nAccept: text/html\r\nConnection: close\r\n\r\n'
out['tcp_http_get'] = eth(B, A, 0x0800, ipv4('192.168.1.10', '192.168.1.2', 128, 6, 22, tcp('192.168.1.10', '192.168.1.2', 49200, 80, 2197249644, 2276102493, 0x18, 64240, payload=get), df=True))
print(json.dumps({k: v.hex() for k, v in out.items()}, indent=2))
