// Открыть .pcap/.pcapng с диска и сохранить захват в .pcap. Лёгкий модуль: нужен и до загрузки анализатора.
import { useCapture } from '../store/capture';

export const PCAP_ACCEPT = '.pcap,.pcapng,.cap,application/vnd.tcpdump.pcap';

export async function openPcapFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Разбор файла и декодеры — в чанке анализатора, основная сборка их не тянет.
  const { FileCapture, PcapError } = await import('./openPcap');
  try {
    useCapture.getState().openFile(FileCapture.open(file.name, bytes));
  } catch (e) {
    alert(`Не удалось открыть «${file.name}»: ${e instanceof PcapError ? e.message : (e as Error).message}`);
  }
}

export function downloadBytes(name: string, bytes: Uint8Array, type = 'application/vnd.tcpdump.pcap') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** Имя файла из подписи вкладки: «ПК1 Fa0 ↔ Свитч Fa0/1» → «ПК1-Fa0--Свитч-Fa0-1.pcap». */
export function pcapName(title: string, suffix = '') {
  const base = title.replace(/^📄\s*/, '').replace(/\.(pcapng|pcap|cap)$/i, '').replace(/↔/g, '-').replace(/[\/:*?"<>|\s]+/g, '-').replace(/-{3,}/g, '--').replace(/^-|-$/g, '');
  return `${base || 'capture'}${suffix}.pcap`;
}
