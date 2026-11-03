import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Device } from '@ciscobanka/engine';
import { DeviceIcon } from './icons';
import { shutdownWithIp } from '../ui/portInfo';
import { useCapture } from '../store/capture';

export type DeviceNodeType = Node<{ device: Device; pending: boolean }, 'device'>;

const handleStyle = { left: '50%', top: 32, width: 1, height: 1, minWidth: 0, minHeight: 0, opacity: 0, border: 0, transform: 'translate(-50%,-50%)' };

export const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<DeviceNodeType>) {
  const d = data.device;
  const warn = shutdownWithIp(d);
  const onPath = useCapture((s) => !!s.highlight?.devices.has(d.id));
  // Захват на одном из интерфейсов устройства — лупа на значке, клик открывает вкладку.
  const capTab = useCapture((s) => s.tabs.find((t) => t.point.kind === 'port' && t.cap.running && d.ports.some((p) => p.id === (t.point as { portId: string }).portId)));
  return (
    <div className={`device-node${selected ? ' selected' : ''}${data.pending ? ' pending' : ''}${onPath ? ' on-path' : ''}`}>
      <Handle type="source" position={Position.Top} id="c" style={handleStyle} isConnectable={false} />
      <Handle type="target" position={Position.Top} id="c" style={handleStyle} isConnectable={false} />
      <DeviceIcon kind={d.kind} size={64} />
      {warn.length > 0 && (
        <span className="node-warn" title={`Выключены интерфейсы с IP: ${warn.map((w) => w.name).join(', ')}`}>
          !
        </span>
      )}
      {capTab && (
        <button
          className="node-sniffer nodrag"
          onClick={(e) => {
            e.stopPropagation();
            useCapture.getState().setActive(capTab.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title="На интерфейсе устройства идёт захват трафика — открыть вкладку"
        >
          🔍
        </button>
      )}
      <div className="device-name">{d.name}</div>
    </div>
  );
});
