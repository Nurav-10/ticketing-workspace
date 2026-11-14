# Worker foundation

The worker package currently provides only process lifecycle handling. `runWorker` passes an `AbortSignal` to one composed task, requests shutdown on `SIGINT` or `SIGTERM`, waits for that task to settle, and removes its signal listeners. A task must observe abort and finish draining; the lifecycle wrapper does not force-kill it or impose an arbitrary timeout.

The executable currently idles until shutdown because no outbox, queue, scheduled task, or delivery behavior is implemented. It does not connect to PostgreSQL or claim to process work. Add a real handler at the composition point only when its persistence and retry semantics are defined.

Run `bun run --filter @ticketing/worker test` in the project container to exercise lifecycle behavior. The worker targets Node 24, matching the API runtime.
