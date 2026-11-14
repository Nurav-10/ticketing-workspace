import { runWorker } from './worker-lifecycle.js';

// There are no queue consumers or scheduled jobs configured yet. Keep the
// process idle and responsive to container shutdown until a real handler is
// composed here.
await runWorker(
  (signal) => new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  }),
  process,
);
