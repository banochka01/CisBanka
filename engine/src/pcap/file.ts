// Мост между захватом и файлами: экспорт вкладки в .pcap и вкладка из открытого файла.
import type { CapturedFrame } from '../capture/capture';
import { packetBytes } from '../capture/bytes';
import { readPcap, writePcap, type PcapFile } from './pcap';

/** Кадр из открытого файла: только байты и время, без связи со схемой. */
export interface ImportedFrame {
  no: number;
  /** Время, мс (из файла). */
  time: number;
  bytes: Uint8Array;
  origLen: number;
}

export type AnyFrame = CapturedFrame | ImportedFrame;

export const isImported = (f: AnyFrame): f is ImportedFrame => 'bytes' in f;

export function frameBytes(f: AnyFrame): Uint8Array {
  return isImported(f) ? f.bytes : packetBytes(f.packet);
}

/** Захват «только для просмотра» из файла: тот же интерфейс, что у Capture, но без симулятора. */
export class FileCapture {
  readonly running = false;
  frames: ImportedFrame[];
  readonly format: PcapFile['format'];
  readonly warnings: string[];

  constructor(
    readonly name: string,
    file: PcapFile,
  ) {
    this.format = file.format;
    this.warnings = file.warnings;
    this.frames = file.frames.map((f, i) => ({ no: i + 1, time: f.time, bytes: f.data, origLen: f.origLen }));
  }

  static open(name: string, bytes: Uint8Array): FileCapture {
    return new FileCapture(name, readPcap(bytes));
  }

  sync(_sim?: unknown): boolean {
    return false;
  }
  stop(_sim?: unknown) {}
  resume(_sim?: unknown) {}
  clear(_sim?: unknown) {
    this.frames = [];
  }
}

/** Кадры вкладки → .pcap (время — модельное или из исходного файла). */
export function framesToPcap(frames: readonly AnyFrame[]): Uint8Array {
  return writePcap(frames.map((f) => ({ time: f.time, data: frameBytes(f), origLen: isImported(f) ? f.origLen : undefined })));
}
