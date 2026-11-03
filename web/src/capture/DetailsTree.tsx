// Дерево разбора выбранного пакета: Frame → Ethernet → IP → TCP → …, узлы раскрываются.
import { useEffect, useRef } from 'react';
import type { Field } from '@ciscobanka/engine';

/** Путь узла в дереве — ключ для раскрытия и выбора: «2/5/1». */
export type FieldKey = string;

interface Props {
  tree: Field[];
  expanded: Set<FieldKey>;
  selected: FieldKey | null;
  onToggle: (key: FieldKey) => void;
  onSelect: (key: FieldKey, f: Field) => void;
}

function Node({ f, k, depth, ...p }: Props & { f: Field; k: FieldKey; depth: number }) {
  const open = p.expanded.has(k);
  const sel = p.selected === k;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  return (
    <>
      <div
        ref={ref}
        role="treeitem"
        aria-expanded={f.children ? open : undefined}
        aria-selected={sel}
        className={`dt-row${sel ? ' sel' : ''}${depth === 0 ? ' top' : ''}`}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => p.onSelect(k, f)}
        onDoubleClick={() => f.children && p.onToggle(k)}
        title={f.name ? `${f.name}${f.len ? ` · байты ${f.start}–${f.start + f.len - 1}` : ''}` : undefined}
      >
        <span
          className="dt-twist"
          onClick={(e) => {
            e.stopPropagation();
            if (f.children) p.onToggle(k);
          }}
        >
          {f.children ? (open ? '▾' : '▸') : ''}
        </span>
        {f.label}
      </div>
      {open && f.children?.map((c, i) => <Node key={i} f={c} k={`${k}/${i}`} depth={depth + 1} {...p} />)}
    </>
  );
}

export function DetailsTree(p: Props) {
  return (
    <div
      className="dt"
      role="tree"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!p.selected) return;
        if (e.key === 'ArrowRight' && !p.expanded.has(p.selected)) p.onToggle(p.selected);
        if (e.key === 'ArrowLeft' && p.expanded.has(p.selected)) p.onToggle(p.selected);
      }}
    >
      {p.tree.map((f, i) => (
        <Node key={i} f={f} k={`${i}`} depth={0} {...p} />
      ))}
    </div>
  );
}

/** Узел по ключу. */
export function fieldByKey(tree: Field[], key: FieldKey): Field | null {
  let list: Field[] | undefined = tree;
  let f: Field | null = null;
  for (const part of key.split('/')) {
    f = list?.[Number(part)] ?? null;
    if (!f) return null;
    list = f.children;
  }
  return f;
}

/** Ключ узла по пути из fieldAt. */
export function keyOfPath(tree: Field[], path: Field[]): FieldKey {
  const parts: number[] = [];
  let list: Field[] | undefined = tree;
  for (const f of path) {
    const i: number = list ? list.indexOf(f) : -1;
    if (i < 0) break;
    parts.push(i);
    list = f.children;
  }
  return parts.join('/');
}
