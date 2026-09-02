/**
 * A read result may carry a zero-arg function under this symbol. Calling it
 * tells the producer the bytes are consumed and their backing memory may be
 * reused. Optional everywhere: a producer need not attach it, a consumer
 * that copies synchronously may call it right away, and one that holds the
 * buffer across an async boundary (a socket write) must call it only once
 * the write has completed.
 */
export const RELEASE_BUFFER: unique symbol = Symbol.for(
  'fsmux.release',
) as never;

export type ReleasableBuffer = Buffer & { [RELEASE_BUFFER]?: () => void };

/** Call a buffer's release hook, if it carries one. */
export function releaseBuffer(buf: Uint8Array): void {
  (buf as ReleasableBuffer)[RELEASE_BUFFER]?.();
}
