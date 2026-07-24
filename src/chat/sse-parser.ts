/**
 * Minimal, dependency-free Server-Sent-Events frame parser (honua-studio#6).
 * Exists as its own module — independent of `fetch`/`ReadableStream` — so
 * split-chunk boundary behavior (a frame's bytes arriving across two or more
 * `TextDecoder.decode()` calls, at ANY split point: mid-field-name,
 * mid-value, mid-line-terminator, mid-blank-line-terminator) is unit
 * testable without a real network stream.
 *
 * Only the two fields honua-server#3010's `StudioAiProxyEndpoints` actually
 * writes are parsed (`event:`, `data:`); `id:`/`retry:`/comment (`:`-prefixed)
 * lines are recognized (so they don't corrupt buffering) and otherwise
 * ignored, matching the SSE spec's field vocabulary at
 * https://html.spec.whatwg.org/multipage/server-sent-events.html — a
 * generic-enough subset that a proxy/CDN "helpfully" re-chunking the stream
 * differently than a single write-per-line never breaks this parser.
 */

export interface SseFrame {
  /** The `event:` field's value, or `"message"` per spec default when omitted. */
  readonly event: string;
  /** Every `data:` line's value, joined with `\n` (spec: multiple `data:` lines accumulate into one multi-line value). */
  readonly data: string;
}

/**
 * Stateful incremental frame parser. Feed raw decoded text via {@link push};
 * each call returns zero or more COMPLETE frames (a frame dispatches only on
 * its terminating blank line, exactly per spec — a frame split across pushes
 * never double-dispatches or drops data).
 */
export class SseFrameParser {
  #buffer = "";
  #pendingEvent = "";
  #pendingDataLines: string[] = [];
  #hasPending = false;

  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    let newlineIndex: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard incremental-buffer parse loop
    while ((newlineIndex = this.#buffer.indexOf("\n")) !== -1) {
      const rawLine = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line === "") {
        const frame = this.#dispatchPending();
        if (frame) frames.push(frame);
        continue;
      }
      if (line.startsWith(":")) continue; // comment line — ignored per spec

      const colonIndex = line.indexOf(":");
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") {
        this.#pendingEvent = value;
        this.#hasPending = true;
      } else if (field === "data") {
        this.#pendingDataLines.push(value);
        this.#hasPending = true;
      }
      // id:/retry:/unknown fields: recognized-but-ignored (not part of this contract).
    }
    return frames;
  }

  #dispatchPending(): SseFrame | undefined {
    if (!this.#hasPending) return undefined;
    const frame: SseFrame = { event: this.#pendingEvent || "message", data: this.#pendingDataLines.join("\n") };
    this.#pendingEvent = "";
    this.#pendingDataLines = [];
    this.#hasPending = false;
    return frame;
  }
}
