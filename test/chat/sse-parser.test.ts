import { describe, expect, it } from "vitest";

import { SseFrameParser } from "../../src/chat/sse-parser.js";

const FRAME = 'event: text_delta\ndata: {"type":"textDelta","text":"hi"}\n\n';

describe("chat/sse-parser", () => {
  it("parses a single complete frame delivered in one push", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(FRAME);
    expect(frames).toEqual([{ event: "text_delta", data: '{"type":"textDelta","text":"hi"}' }]);
  });

  it("parses multiple frames delivered in one push", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(FRAME + FRAME);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: "text_delta", data: '{"type":"textDelta","text":"hi"}' });
    expect(frames[1]).toEqual(frames[0]);
  });

  it("reassembles a frame split at every possible character boundary", () => {
    for (let splitAt = 1; splitAt < FRAME.length; splitAt += 1) {
      const parser = new SseFrameParser();
      const first = parser.push(FRAME.slice(0, splitAt));
      const second = parser.push(FRAME.slice(splitAt));
      const frames = [...first, ...second];
      expect(frames, `split at ${splitAt}`).toEqual([{ event: "text_delta", data: '{"type":"textDelta","text":"hi"}' }]);
    }
  });

  it("reassembles a frame split into many small chunks (byte-at-a-time)", () => {
    const parser = new SseFrameParser();
    const frames: { event: string; data: string }[] = [];
    for (const char of FRAME) {
      frames.push(...parser.push(char));
    }
    expect(frames).toEqual([{ event: "text_delta", data: '{"type":"textDelta","text":"hi"}' }]);
  });

  it("handles a frame split exactly between the two CRLF terminator bytes", () => {
    const crlfFrame = 'event: message_stop\r\ndata: {"type":"messageStop"}\r\n\r\n';
    const splitPoint = crlfFrame.indexOf("\r\n\r\n") + 1; // split inside the blank-line terminator
    const parser = new SseFrameParser();
    const frames = [...parser.push(crlfFrame.slice(0, splitPoint)), ...parser.push(crlfFrame.slice(splitPoint))];
    expect(frames).toEqual([{ event: "message_stop", data: '{"type":"messageStop"}' }]);
  });

  it("accumulates multiple data: lines into one newline-joined value", () => {
    const parser = new SseFrameParser();
    const frames = parser.push("event: text_delta\ndata: line one\ndata: line two\n\n");
    expect(frames).toEqual([{ event: "text_delta", data: "line one\nline two" }]);
  });

  it("defaults the event name to 'message' when the event: field is omitted", () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: {"ok":true}\n\n');
    expect(frames).toEqual([{ event: "message", data: '{"ok":true}' }]);
  });

  it("ignores comment lines (':'-prefixed) without corrupting subsequent parsing", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(`: keepalive\n${FRAME}`);
    expect(frames).toEqual([{ event: "text_delta", data: '{"type":"textDelta","text":"hi"}' }]);
  });

  it("never dispatches an incomplete trailing frame (no terminating blank line yet)", () => {
    const parser = new SseFrameParser();
    const frames = parser.push('event: text_delta\ndata: {"type":"textDelta","text":"partial"}\n');
    expect(frames).toEqual([]);
  });

  it("keeps frame boundaries correct across an arbitrary multi-frame, multi-chunk stream", () => {
    const stream =
      'event: message_start\ndata: {"type":"messageStart","model":"m"}\n\n' +
      'event: text_delta\ndata: {"type":"textDelta","text":"a"}\n\n' +
      'event: text_delta\ndata: {"type":"textDelta","text":"b"}\n\n' +
      'event: message_stop\ndata: {"type":"messageStop","stopReason":"endTurn"}\n\n';
    // Split at a handful of arbitrary, deliberately-misaligned points.
    const splits = [7, 23, 41, 90, stream.length - 5];
    const parser = new SseFrameParser();
    let cursor = 0;
    const frames: { event: string; data: string }[] = [];
    for (const point of splits) {
      frames.push(...parser.push(stream.slice(cursor, point)));
      cursor = point;
    }
    frames.push(...parser.push(stream.slice(cursor)));

    expect(frames.map((f) => f.event)).toEqual(["message_start", "text_delta", "text_delta", "message_stop"]);
    expect(JSON.parse(frames[3].data)).toEqual({ type: "messageStop", stopReason: "endTurn" });
  });
});
