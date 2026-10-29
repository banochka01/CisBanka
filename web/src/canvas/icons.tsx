import type { DeviceKind } from '@ciscobanka/engine';

/** Упрощённые иконки в духе схем Cisco. */
export function DeviceIcon({ kind, size = 56 }: { kind: DeviceKind; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true } as const;
  switch (kind) {
    case 'router':
      return (
        <svg {...common}>
          <ellipse cx="32" cy="40" rx="26" ry="10" fill="var(--dev-router)" />
          <rect x="6" y="26" width="52" height="14" fill="var(--dev-router)" />
          <ellipse cx="32" cy="26" rx="26" ry="10" fill="var(--dev-router-top)" />
          <path d="M20 26h9m-3-3 3 3-3 3M44 26h-9m3-3-3 3 3 3M32 18v5m-3-3 3-3 3 3M32 34v-5m-3 3 3 3 3-3" stroke="#fff" strokeWidth="2" fill="none" />
        </svg>
      );
    case 'switch':
      return (
        <svg {...common}>
          <path d="M8 24h44l6-6H14z" fill="var(--dev-switch-top)" />
          <rect x="8" y="24" width="44" height="18" fill="var(--dev-switch)" />
          <path d="M52 24l6-6v18l-6 6z" fill="var(--dev-switch-side)" />
          <path d="M16 30h12m-3-3 3 3-3 3M44 36H32m3-3-3 3 3 3" stroke="#fff" strokeWidth="2" fill="none" />
        </svg>
      );
    case 'hub':
      return (
        <svg {...common}>
          <rect x="8" y="24" width="48" height="16" rx="3" fill="var(--dev-hub)" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={13 + i * 7} y="30" width="4" height="4" fill="#fff" />
          ))}
        </svg>
      );
    case 'server':
      return (
        <svg {...common}>
          <rect x="18" y="8" width="28" height="48" rx="3" fill="var(--dev-server)" />
          {[16, 26, 36].map((y) => (
            <g key={y}>
              <rect x="22" y={y} width="20" height="6" rx="1" fill="var(--dev-server-slot)" />
              <circle cx="38" cy={y + 3} r="1.5" fill="#6f6" />
            </g>
          ))}
        </svg>
      );
    case 'laptop':
      return (
        <svg {...common}>
          <rect x="14" y="14" width="36" height="24" rx="2" fill="var(--dev-pc)" />
          <rect x="17" y="17" width="30" height="18" fill="var(--dev-screen)" />
          <path d="M8 44h48l-4-6H12z" fill="var(--dev-pc)" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="10" y="10" width="44" height="30" rx="2" fill="var(--dev-pc)" />
          <rect x="14" y="14" width="36" height="22" fill="var(--dev-screen)" />
          <rect x="28" y="40" width="8" height="6" fill="var(--dev-pc)" />
          <rect x="20" y="46" width="24" height="4" rx="1" fill="var(--dev-pc)" />
        </svg>
      );
  }
}
