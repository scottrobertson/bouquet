import { EventEmitter } from "node:events";

// In-memory bus so background sync/probe runs can tell open browser tabs that a
// source changed, instead of every tab polling on a timer. Only works because
// the app is a single Node process (see server.js); a sync/probe run and the SSE
// route that streams to the browser share this same emitter.

export type SourceChange = { sourceId: number };

// Reuse one emitter across HMR reloads, like the db connection.
const globalForEvents = globalThis as unknown as {
  __sourceEvents?: EventEmitter;
};

const emitter = globalForEvents.__sourceEvents ?? new EventEmitter();
globalForEvents.__sourceEvents = emitter;

// One listener per open SSE connection, so a busy household can have plenty.
emitter.setMaxListeners(1000);

const CHANGE = "source-change";

/** Tell any connected tabs that this source's sync/probe state moved. Cheap and
    fire-and-forget; tabs decide whether they care. */
export function bumpSource(sourceId: number): void {
  emitter.emit(CHANGE, { sourceId } satisfies SourceChange);
}

/** Subscribe to source changes. Returns an unsubscribe function. */
export function onSourceChange(listener: (change: SourceChange) => void): () => void {
  emitter.on(CHANGE, listener);
  return () => emitter.off(CHANGE, listener);
}
