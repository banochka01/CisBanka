import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import { checkCable, type DeviceKind } from '@ciscobanka/engine';
import { useStore } from '../store/project';
import { getSim } from '../sim/runtime';
import { DeviceNode, type DeviceNodeType } from './DeviceNode';
import { LinkEdge, type LinkEdgeType } from './LinkEdge';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { link: LinkEdge };
/** Центр иконки относительно левого верхнего угла узла. */
const CENTER = { x: 40, y: 32 };

export function Canvas() {
  const project = useStore((s) => s.project);
  const simTick = useStore((s) => s.simTick);
  const cable = useStore((s) => s.cable);
  const pending = useStore((s) => s.pending);
  const theme = useStore((s) => s.theme);
  const [selNodes, setSelNodes] = useState<Set<string>>(new Set());
  const [selEdges, setSelEdges] = useState<Set<string>>(new Set());
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const rf = useReactFlow();

  const nodes: DeviceNodeType[] = useMemo(
    () =>
      project.devices.map((d) => ({
        id: d.id,
        type: 'device',
        position: d.position,
        data: { device: d, pending: pending?.deviceId === d.id },
        selected: selNodes.has(d.id),
      })),
    [project.devices, selNodes, pending],
  );

  const edges: LinkEdgeType[] = useMemo(() => {
    const sim = getSim();
    const dev = (id: string) => project.devices.find((d) => d.id === id)!;
    return project.links.map((l) => {
      const da = dev(l.a.deviceId);
      const db = dev(l.b.deviceId);
      const pa = da.ports.find((p) => p.id === l.a.portId)!;
      const pb = db.ports.find((p) => p.id === l.b.portId)!;
      const st = sim.linkStatus(l);
      return {
        id: l.id,
        source: l.a.deviceId,
        target: l.b.deviceId,
        sourceHandle: 'c',
        targetHandle: 'c',
        type: 'link',
        selected: selEdges.has(l.id),
        data: {
          cable: l.cable,
          ledA: sim.portLed(pa.id),
          ledB: sim.portLed(pb.id),
          portA: pa.name,
          portB: pb.name,
          devA: da.name,
          devB: db.name,
          up: st.up,
          reason: st.reason,
          badCable: !checkCable(l.cable, { device: da, port: pa }, { device: db, port: pb }).ok,
        },
      };
    });
    // simTick: индикаторы зависят от состояния симулятора
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selEdges, simTick]);

  const onNodesChange = useCallback((changes: NodeChange<DeviceNodeType>[]) => {
    const st = useStore.getState();
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        if (c.dragging) {
          st.beginDrag();
          st.dragTo(c.id, c.position);
        }
      } else if (c.type === 'select') {
        setSelNodes((s) => {
          const n = new Set(s);
          if (c.selected) n.add(c.id);
          else n.delete(c.id);
          return n;
        });
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdgeType>[]) => {
    for (const c of changes) {
      if (c.type === 'select') {
        setSelEdges((s) => {
          const n = new Set(s);
          if (c.selected) n.add(c.id);
          else n.delete(c.id);
          return n;
        });
      }
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const kind = e.dataTransfer.getData('application/x-device') as DeviceKind;
      if (!kind) return;
      e.preventDefault();
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      useStore.getState().addDevice(kind, { x: Math.round(pos.x - CENTER.x), y: Math.round(pos.y - CENTER.y) });
    },
    [rf],
  );

  const pendingDev = pending && project.devices.find((d) => d.id === pending.deviceId);

  return (
    <div
      className={`canvas${cable ? ' cable-mode' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
      onMouseMove={(e) => pending && setMouse(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={() => useStore.getState().endDrag()}
        onNodeClick={(e, n) => {
          if (useStore.getState().cable) useStore.getState().openPicker(n.id, e.clientX, e.clientY);
        }}
        onNodeDoubleClick={(_, n) => {
          if (!useStore.getState().cable) useStore.getState().openWindow(n.id);
        }}
        onPaneClick={() => useStore.setState({ picker: null })}
        onDelete={({ nodes: dn, edges: de }) => {
          useStore.getState().removeItems(
            dn.map((n) => n.id),
            de.map((x) => x.id),
          );
          setSelNodes(new Set());
          setSelEdges(new Set());
        }}
        deleteKeyCode={['Delete', 'Backspace']}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        colorMode={theme}
        minZoom={0.2}
        maxZoom={3}
        fitView
        fitViewOptions={{ maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        {pendingDev && mouse && (
          <ViewportPortal>
            <svg className="pending-wire" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
              <line
                x1={pendingDev.position.x + CENTER.x}
                y1={pendingDev.position.y + CENTER.y}
                x2={mouse.x}
                y2={mouse.y}
                stroke="var(--accent)"
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            </svg>
          </ViewportPortal>
        )}
      </ReactFlow>
    </div>
  );
}
