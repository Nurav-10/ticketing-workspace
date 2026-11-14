export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface ShutdownSignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export type WorkerTask = (signal: AbortSignal) => Promise<void>;

/**
 * Runs one worker task and converts process shutdown signals into an abort
 * request. Tasks own their drain behavior and must settle after abort.
 */
export async function runWorker(task: WorkerTask, signals: ShutdownSignalSource): Promise<void> {
  const controller = new AbortController();
  const requestStop = () => controller.abort();

  signals.on('SIGINT', requestStop);
  signals.on('SIGTERM', requestStop);
  try {
    await task(controller.signal);
  } finally {
    signals.off('SIGINT', requestStop);
    signals.off('SIGTERM', requestStop);
  }
}
