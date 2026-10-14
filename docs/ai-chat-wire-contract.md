# The Studio AI proxy wire contract (client side)

honua-studio#6 implements `<honua-studio-chat>`'s `SseChatTransport`
against honua-server#3010 ("feat(ai): provider-agnostic Studio AI proxy
adapters"). This document records the exact wire shapes as verified against
that PR's diff (not guessed from the prose guide alone) — `src/chat/ai-contract.ts`
is the TypeScript source of truth; this is the prose cross-reference.

> **The live loop is SDK-owned.** `<honua-studio-app>` installs
> `@honua/sdk-js/studio-agent`'s `StudioAgentSession`, which declares the
> SDK kit's tools to the proxy, executes model-selected calls, returns a
> `role: "tool"` result, and continues until the model ends the turn. The
> local wire modules remain for deterministic fixture replay and its tests.

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

The property policy applies to object keys, not enum values. Actual retained
server responses serialize `StudioAiChatEventType.MessageStart` as
`"MessageStart"` and `StudioAiStopReason.EndTurn` as `"EndTurn"`. This spelling
predates the managed diagnostic and is also present in the signed provider
transcript. Earlier documentation incorrectly claimed the property policy
camelcased enum values.

The client event `type` is projected from the authoritative SSE event name.
Other signed payload values, including `stopReason`, remain unchanged. Local
fixture projections use camelCase reasons; completion checks accept only the
explicit successful pairs `EndTurn`/`endTurn` and, when complete tool calls
exist, `ToolCall`/`toolCall`. Unknown, mixed-case, filtered, cancelled, truncated
and error reasons are not successful completion. Null/absent fields are omitted
from the server wire payload.

The SDK verifier checks the signature over original canonical transcript bytes,
then compares decoded request and provider events. It explicitly maps the
server's event-type spelling, but does **not** normalize stop reasons. Rewriting
`EndTurn` to `endTurn` before verification changes the observed payload and must
fail event binding. Diagnostic completion predicates interpret a reason without
mutating it, and action-round nonce consumption remains at the SDK dispatch
boundary. Rejection errors include only a bounded stop-reason value.

## Two SEPARATE event-name vocabularies — the trap this contract avoids

The SSE `event:` line is a DIFFERENT, hardcoded snake_case vocabulary,
written by `StudioAiProxyEndpoints.EventName()` — independent of the JSON
naming policy above:

| SSE `event:` line | Server JSON body's `"type"` field |
| --- | --- |
| `message_start` | `"MessageStart"` |
| `text_delta` | `"TextDelta"` |
| `tool_call_start` | `"ToolCallStart"` |
| `tool_call_delta` | `"ToolCallDelta"` |
| `tool_call_stop` | `"ToolCallStop"` |
| `message_stop` | `"MessageStop"` |
| `error` | `"Error"` |

A frame on the wire looks like:

```
event: text_delta
data: {"type":"TextDelta","text":"Adding the parcels layer"}

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

## Tool-loop ownership

The app supplies the current `HonuaAiMapKit` definitions to
`StudioAgentSession`; its system prompt is rebuilt from the current catalog
and composition before each user turn. `agentToolDefinitions` is an explicit
provider seam: today it returns the published SDK's static schemas, and can
switch to sdk-js#1397 discovery without changing the chat loop. Assigning an
explicit `ChatTransport` detaches the live session, keeping fixture playback
network- and model-free.
