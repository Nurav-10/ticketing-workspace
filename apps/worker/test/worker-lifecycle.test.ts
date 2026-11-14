import { expect, test } from 'bun:test';
import { runWorker, type ShutdownSignal, type ShutdownSignalSource } from '../src/worker-lifecycle.js';

class FakeSignals implements ShutdownSignalSource {
  private readonly listeners = new Map<ShutdownSignal, Set<() => void>>();

  on(signal: ShutdownSignal, listener: () => void): this {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
    return this;
  }

  off(signal: ShutdownSignal, listener: () => void): this {
    this.listeners.get(signal)?.delete(listener);
    return this;
  }

  emit(signal: ShutdownSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(signal: ShutdownSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

test('shutdown aborts the task and removes signal listeners after drain', async () => {
  const signals = new FakeSignals();
  let observedSignal: AbortSignal | undefined;
  let drained = false;

  const running = runWorker(async (signal) => {
    observedSignal = signal;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
      drained = true;
      resolve();
    }, { once: true }));
  }, signals);

  expect(signals.count('SIGINT')).toBe(1);
  expect(signals.count('SIGTERM')).toBe(1);
  signals.emit('SIGTERM');
  await running;

  expect(observedSignal?.aborted).toBe(true);
  expect(drained).toBe(true);
  expect(signals.count('SIGINT')).toBe(0);
  expect(signals.count('SIGTERM')).toBe(0);
});

test('task failures propagate and still remove signal listeners', async () => {
  const signals = new FakeSignals();
  const failure = new Error('worker failed');

  await expect(runWorker(async () => { throw failure; }, signals)).rejects.toBe(failure);

  expect(signals.count('SIGINT')).toBe(0);
  expect(signals.count('SIGTERM')).toBe(0);
});
