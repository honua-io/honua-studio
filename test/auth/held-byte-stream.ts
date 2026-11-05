export interface HeldByteStream {
  body: ReadableStream<Uint8Array>;
  started: Promise<void>;
  release: () => void;
  wasCancelled: () => boolean;
}

export function heldByteStream(
  deliver: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): HeldByteStream {
  let release!: () => void;
  let opened!: () => void;
  let cancelled = false;
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await new Promise<void>((resolve) => {
          release = resolve;
          opened();
        });
        deliver(controller);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, started, release: () => release(), wasCancelled: () => cancelled };
}
