import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Device } from '@ciscobanka/engine';
import { DeviceIcon } from './icons';
import { shutdownWithIp } from '../ui/portInfo';

export type DeviceNodeType = Node<{ device: Device; pending: boolean }, 'device'>;

const handleStyle = { left: '50%', top: 32, width: 1, height: 1, minWidth: 0, minHeight: 0, opacity: 0, border: 0, transform: 'translate(-50%,-50%)' };

export const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<DeviceNodeType>) {
  const d = data.device;
  const warn = shutdownWithIp(d);
  return (
    <div className={`device-node${selected ? ' selected' : ''}${data.pending ? ' pending' : ''}`}>
      <Handle type="source" position={Position.Top} id="c" style={handleStyle} isConnectable={false} />
      <Handle type="target" position={Position.Top} id="c" style={handleStyle} isConnectable={false} />
      <DeviceIcon kind={d.kind} size={64} />
      {warn.length > 0 && (
        <span className="node-warn" title={`Выключены интерфейсы с IP: ${warn.map((w) => w.name).join(', ')}`}>
          !
        </span>
      )}
      <div className="device-name">{d.name}</div>
    </div>
  );
});
