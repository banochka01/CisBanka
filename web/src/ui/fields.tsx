import { useEffect, useState, type ReactNode } from 'react';
import { isValidIp, maskToPrefix } from '@ciscobanka/engine';

type Kind = 'ip' | 'mask' | 'text' | 'number';

function validate(kind: Kind, v: string): string | null {
  if (kind === 'ip' && !isValidIp(v)) return 'Неверный IP-адрес (пример: 192.168.1.10)';
  if (kind === 'mask') {
    if (!isValidIp(v)) return 'Неверная маска (пример: 255.255.255.0)';
    if (maskToPrefix(v) === null) return 'Маска должна быть непрерывной: единицы, потом нули';
  }
  if (kind === 'number' && !/^\d+$/.test(v)) return 'Нужно целое число';
  return null;
}

/**
 * Поле, которое применяет значение по Enter или при потере фокуса — и только если оно корректно.
 * Пустое значение допустимо при optional (передаётся undefined).
 */
export function Field({
  label,
  value,
  onCommit,
  kind = 'text',
  optional,
  placeholder,
  width,
  check,
}: {
  label?: ReactNode;
  value: string | undefined;
  onCommit: (v: string | undefined) => void;
  kind?: Kind;
  optional?: boolean;
  placeholder?: string;
  width?: number;
  check?: (v: string) => string | null;
}) {
  const [text, setText] = useState(value ?? '');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(value ?? '');
    setErr(null);
  }, [value]);

  const commit = () => {
    const v = text.trim();
    if (v === (value ?? '')) return setErr(null);
    if (!v) {
      if (optional) {
        setErr(null);
        onCommit(undefined);
      } else setErr('Обязательное поле');
      return;
    }
    const e = validate(kind, v) ?? check?.(v) ?? null;
    setErr(e);
    if (!e) onCommit(v);
  };

  return (
    <label className={`field${err ? ' invalid' : ''}`}>
      {label && <span className="field-label">{label}</span>}
      <input
        value={text}
        placeholder={placeholder}
        style={width ? { width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setText(value ?? '');
            setErr(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {err && <span className="field-error">{err}</span>}
    </label>
  );
}

export function Toggle({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
