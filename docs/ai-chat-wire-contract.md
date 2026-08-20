# The Studio AI proxy wire contract (client side)

honua-studio#6 implements `<honua-studio-chat>`'s `SseChatTransport`
against honua-server#3010 ("feat(ai): provider-agnostic Studio AI proxy
adapters"). This document records the exact wire shapes as verified against
that PR's diff (not guessed from the prose guide alone) — `src/chat/ai-contract.ts`
is the TypeScript source of truth; this is the prose cross-reference.

## Endpoints

- `GET /api/v{version}/studio/ai/capabilities` — admin-authorized, returns
  `ApiResponse<StudioAiCapabilitiesResponse>` (`{ success, data }` envelope).
  `src/chat/capabilities-client.ts`'s `fetchStudioAiCapabilities()` unwraps
  this; not yet wired into `<honua-studio-chat>`'s render path (out of scope
  for #6's minimal console — a future revision or honua-studio#8 can call it
  without re-inventing bearer-attach/envelope handling).
- `POST /api/v{version}/studio/ai/chat` — admin-authorized, streams one chat
  turn as Server-Sent Events. `SseChatTransport` (`src/chat/sse-transport.ts`)
  speaks this exactly.

## JSON casing — verified, not assumed

The server's `StudioAiProxyJsonContext` (`src/Honua.Ai/Features/StudioAiProxy/StudioAiProxyJsonContext.cs`
in honua-server) declares:

```csharp
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UseStringEnumConverter = true)]
```

This means BOTH object keys AND C# enum values serialize camelCase:
`StudioAiChatEventType.MessageStart` -> `"messageStart"`,
`StudioAiStopReason.EndTurn` -> `"endTurn"`. `src/chat/ai-contract.ts`'s
`StudioAiChatEventType`/`StudioAiStopReason` string unions match this
casing exactly (`"messageStart"`, `"textDelta"`, `"toolCallStart"`,
`"toolCallDelta"`, `"toolCallStop"`, `"messageStop"`, `"error"`; stop
reasons `"endTurn"`, `"toolCall"`, `"maxTokens"`, `"contentFilter"`,
`"cancelled"`, `"error"`). Null/absent fields are omitted from the wire
payload, not sent as `null`.

## Two SEPARATE event-name vocabularies — the trap this contract avoids

The SSE `event:` line is a DIFFERENT, hardcoded snake_case vocabulary,
written by `StudioAiProxyEndpoints.EventName()` — independent of the JSON
naming policy above:

| SSE `event:` line | JSON body's `"type"` field |
| --- | --- |
| `message_start` | `"messageStart"` |
| `text_delta` | `"textDelta"` |
| `tool_call_start` | `"toolCallStart"` |
| `tool_call_delta` | `"toolCallDelta"` |
| `tool_call_stop` | `"toolCallStop"` |
| `message_stop` | `"messageStop"` |
| `error` | `"error"` |

A frame on the wire looks like:

```
event: text_delta
data: {"type":"textDelta","text":"Adding the parcels layer"}

```

`src/chat/ai-contract.ts`'s `SSE_EVENT_NAME_TO_TYPE` (and its inverse,
`CHAT_EVENT_TYPE_TO_SSE_NAME`, used by `FixtureChatTransport` and
`mock-server.mjs`) bridges the two vocabularies. `SseChatTransport` treats
the `event:` line as the authoritative discriminant and OVERWRITES the
parsed body's own `"type"` field with it — a missing/mismatched body
`"type"` can never desync the parser.

## Request body

`StudioAiChatHttpRequest` (camelCase, matches `src/chat/ai-contract.ts`'s
`StudioAiChatRequest` exactly):

```jsonc
{
  "provider": "claude",        // optional
  "model": "claude-opus-4-1",  // optional
  "system": "…",               // optional
  "messages": [
    { "role": "user", "content": "…", "toolCallId": "…", "toolName": "…" }
  ],
  "tools": [{ "name": "…", "description": "…", "inputSchema": {} }],
  "toolChoice": { "mode": "auto", "toolName": "…" },
  "maxTokens": 2048,
  "temperature": 0.2
}
```

`role` is lower-case (`"system"`, `"user"`, `"assistant"`, `"tool"`);
`toolChoice.mode` is lower-case (`"auto"`, `"none"`, `"required"`,
`"specific"`). The server rejects (`400`, before any SSE header is written)
an unknown role/mode spelling, an empty `messages`, an oversized prompt, or
`tools` against a provider with `SupportsTools: false`.

## Cancellation

No separate cancel endpoint. Aborting the client's `fetch` (an
`AbortController.abort()` on the request `signal`) closes the connection,
which the server treats as `StudioAiStopReason.Cancelled` server-side and
stops the upstream call. `SseChatTransport.streamChat()` passes its
`signal` straight through to `fetch()` and swallows the resulting
`AbortError` (returns cleanly, yields nothing further) rather than throwing
— matching `ChatTransport`'s contract that cancellation is a normal outcome,
not a transport failure.

## Live session ownership

In live composition mode, SDK `StudioAgentSession` declares the governed tool
schemas, sends `toolChoice`, executes each tool in order, feeds the tool result
back as a `role: "tool"` message, and continues until the model ends the turn.
It also consults `/capabilities` to resolve the configured provider. The raw
`SseChatTransport` path remains only for deterministic fixture conversations
and embedders that explicitly supply their own transport.
