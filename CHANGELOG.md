# @martian-engineering/lossless-claw

## 0.3.1

### Patch Changes

- 6c54c7b: Declare explicit OpenClaw tool names for the LCM factory-registered tools so
  plugin metadata and tool listings stay populated in hosts that require
  `registerTool(..., { name })` hints for factory registrations.

## 0.3.0

### Minor Changes

- f1dfa5c: Catch up the release notes for work merged after `0.2.8`.

  This release adds Anthropic OAuth setup-token support in the TUI, resolves
  SecretRef-backed auth-profile credentials and provider-level custom provider
  configuration during summarization, and formats LCM tool timestamps in the local
  timezone instead of UTC.
