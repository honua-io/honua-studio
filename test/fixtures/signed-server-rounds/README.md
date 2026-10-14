These are byte-preserving SSE/request excerpts from the failed synthetic managed
model corpus `live-managed-model-MFMcFGjA`, server source
`81346cbe1b85913f065046a3dba66df3a5de8a53` and Studio source
`e01ecffb1cf8e95c9f6adc7567c0424343890dac`. The archive records the original
scorecard hash, SSE hash, request and public signing manifest. It contains no
authorization headers, bearer credentials or private signing keys.

The `.json.raw` suffix preserves archival bytes from formatter rewrites. Tests
parse these files directly, verify the SSE digest and use the real SDK transport
and signature verifier. Verification time is explicitly the signed issue time
plus one second, because this is a historical replay regression. An expired-time
negative remains mandatory. Passing these tests is not a fresh model run, a
corpus score change, or NativeAOT/release qualification.

`tool.json.raw` retains the real `ToolCall` terminal spelling and
`text.json.raw` retains `EndTurn`. Changing only those values to their semantic
camelCase equivalents must still fail the signed event comparison.
