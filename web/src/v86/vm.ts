// Linux-хост (эксперимент): настоящий Linux (Buildroot из v86) в эмуляторе v86 и мост его
// сетевой карты с симулятором. Модуль грузится лениво — только когда пользователь запускает VM.
//
// Кадры: VM → событие net0-send → packetFromFrame → sim.injectFrame (из порта eth0 устройства).
// Симулятор → externalRx → encodeFrame → bus.send('net0-receive') в VM.
// Пока работает хоть одна VM, время модели идёт по часам (см. setClock в sim/runtime).
// Только режим реального времени: в режиме симуляции VM на паузе, кадры к ней отбрасываются.
import { V86 } from 'v86';
import wasmUrl from 'v86/build/v86.wasm?url';
import { encodeFrame, packetFromFrame, type Device } from '@ciscobanka/engine';
import { getMode, getSim, setClock } from '../sim/runtime';
import { useStore } from '../store/project';
import { useSim } from '../store/sim';

export const MAX_VMS = 2;
const ASSETS = `${import.meta.env.BASE_URL}v86/`;

export type VmState = 'loading' | 'booting' | 'configuring' | 'ready' | 'paused' | 'error';

export interface VmTimings {
  start: number;
  assets?: number;
  prompt?: number;
  ready?: number;
}

type Emu = InstanceType<typeof V86> & { bus: { send(ev: string, data: unknown): void } };

export class LinuxVm {
  state: VmState = 'loading';
  error = '';
  emu: Emu | null = null;
  /** Весь вывод консоли (для терминала, открытого позже). */
  private out: number[] = [];
  private outText = '';
  private listeners = new Set<(b: Uint8Array) => void>();
  private stateListeners = new Set<() => void>();
  readonly t: VmTimings = { start: performance.now() };
  private appliedIp = '';
  framesIn = 0;
  framesOut = 0;

  constructor(readonly deviceId: string) {}

  onOutput(fn: (b: Uint8Array) => void) {
    this.listeners.add(fn);
    fn(Uint8Array.from(this.out));
    return () => this.listeners.delete(fn);
  }

  onState(fn: () => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: VmState) {
    this.state = s;
    for (const f of this.stateListeners) f();
  }

  send(text: string) {
    this.emu?.serial0_send(text);
  }

  async boot() {
    try {
      this.emu = new V86({
        wasm_path: wasmUrl,
        memory_size: 64 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: { url: `${ASSETS}seabios.bin` },
        vga_bios: { url: `${ASSETS}vgabios.bin` },
        bzimage: { url: `${ASSETS}buildroot-bzimage68.bin`, async: false },
        cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0',
        net_device: { type: 'virtio' },
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
      } as ConstructorParameters<typeof V86>[0]) as Emu;
    } catch (e) {
      this.error = (e as Error).message;
      this.setState('error');
      return;
    }
    const emu = this.emu;
    emu.add_listener('emulator-loaded', () => {
      this.t.assets = performance.now();
      this.setState('booting');
    });
    emu.add_listener('serial0-output-byte', (b: number) => this.onByte(b));
    emu.add_listener('net0-send', (frame: Uint8Array) => {
      if (getMode() !== 'realtime') return;
      const d = this.device();
      if (!d) return;
      const sim = getSim();
      sim.runUntil(clockNow());
      sim.injectFrame(d.id, d.ports[0].id, packetFromFrame(frame));
      this.framesOut++;
      bump();
    });
  }

  private onByte(b: number) {
    this.out.push(b);
    if (this.out.length > 256 * 1024) this.out.splice(0, this.out.length - 192 * 1024);
    const one = Uint8Array.of(b);
    for (const f of this.listeners) f(one);
    if (this.state === 'booting' || this.state === 'configuring') {
      this.outText = (this.outText + String.fromCharCode(b)).slice(-200);
      if (this.state === 'booting' && /~% $/.test(this.outText)) {
        this.t.prompt = performance.now();
        this.applyIp(true);
      } else if (this.state === 'configuring' && this.outText.includes('CISBANKA-READY')) {
        this.t.ready = performance.now();
        this.setState(getMode() === 'realtime' ? 'ready' : 'paused');
      }
    }
  }

  private device(): Device | undefined {
    return useStore.getState().project.devices.find((x) => x.id === this.deviceId);
  }

  /** IP из «Настройки IP» устройства — в Linux через serial. */
  applyIp(force = false) {
    const d = this.device();
    if (!d || !this.emu) return;
    const p = d.ports[0];
    const ip = p.l3?.ip;
    const gw = d.config.gateway;
    const mac = p.mac.replace(/\./g, '').toLowerCase().replace(/(..)(?!$)/g, '$1:');
    const key = `${mac}|${ip?.addr}|${ip?.mask}|${gw}`;
    if (!force && key === this.appliedIp) return;
    this.appliedIp = key;
    const prefix = ip ? ip.mask.split('.').reduce((n: number, o: string) => n + (Number(o) >>> 0).toString(2).split('1').length - 1, 0) : 24;
    const cmds = [`ip link set eth0 down`, `ip link set eth0 address ${mac}`, `ip addr flush dev eth0`];
    if (ip) cmds.push(`ip addr add ${ip.addr}/${prefix} dev eth0`);
    cmds.push('ip link set eth0 up');
    if (gw) cmds.push(`ip route add default via ${gw}`);
    if (this.state !== 'ready') this.setState('configuring');
    this.send(`${cmds.join('; ')}; echo CISBANKA-READY\n`);
  }

  pause(p: boolean) {
    if (!this.emu || this.state === 'error' || this.state === 'loading') return;
    if (p) {
      void this.emu.stop();
      if (this.state === 'ready') this.setState('paused');
    } else {
      this.emu.run();
      if (this.state === 'paused') this.setState('ready');
    }
  }

  receive(bytes: Uint8Array): boolean {
    if (!this.emu || getMode() !== 'realtime' || (this.state !== 'ready' && this.state !== 'configuring')) return false;
    this.emu.bus.send('net0-receive', bytes);
    this.framesIn++;
    return true;
  }

  destroy() {
    void this.emu?.destroy();
    this.emu = null;
  }
}

const vms = new Map<string, LinuxVm>();

// ---------- часы модели ----------

let wall0 = 0;
let base = 0;
let loop: ReturnType<typeof setInterval> | null = null;
const clockNow = () => Math.max(getSim().now, base + (performance.now() - wall0));

function rebase() {
  wall0 = performance.now();
  base = getSim().now;
}

function bump() {
  useStore.getState().bumpSim();
}

function ensureClock() {
  if (loop) return;
  rebase();
  setClock(clockNow);
  loop = setInterval(() => {
    if (getMode() !== 'realtime') return;
    const sim = getSim();
    const before = sim.logCursor;
    sim.runUntil(clockNow());
    if (sim.logCursor !== before) bump();
  }, 10);
}

function stopClockIfIdle() {
  if (vms.size || !loop) return;
  clearInterval(loop);
  loop = null;
  setClock(null);
}

export function getVm(deviceId: string) {
  return vms.get(deviceId);
}

export function startVm(deviceId: string): LinuxVm | string {
  const have = vms.get(deviceId);
  if (have) return have;
  if (vms.size >= MAX_VMS) return `В эксперименте одновременно работают не больше ${MAX_VMS} Linux-хостов — остановите один из них.`;
  installHooks();
  const vm = new LinuxVm(deviceId);
  vms.set(deviceId, vm);
  ensureClock();
  void vm.boot();
  return vm;
}

export function stopVm(deviceId: string) {
  vms.get(deviceId)?.destroy();
  vms.delete(deviceId);
  stopClockIfIdle();
}

let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  getSim().externalRx = (deviceId, _portId, packet) => vms.get(deviceId)?.receive(encodeFrame(packet)) ?? false;
  // Пересоздание симулятора не происходит (setTopology), но на всякий случай — хук при каждом изменении.
  useStore.subscribe((s, prev) => {
    if (s.project !== prev.project) {
      getSim().externalRx ??= (deviceId, _p, packet) => vms.get(deviceId)?.receive(encodeFrame(packet)) ?? false;
      for (const [id, vm] of vms) {
        if (!s.project.devices.some((d) => d.id === id)) stopVm(id);
        else if (vm.state === 'ready') vm.applyIp();
      }
    }
  });
  // Режим симуляции — VM на паузе; обратно в реальное время — часы с текущего момента модели.
  useSim.subscribe((s, prev) => {
    if (s.mode === prev.mode) return;
    if (s.mode === 'realtime') rebase();
    for (const vm of vms.values()) vm.pause(s.mode !== 'realtime');
  });
}

// Только в разработке: замеры из консоли.
if (import.meta.env.DEV) Object.assign((globalThis as unknown as Record<string, object>).__cisbanka ?? {}, { vms });
