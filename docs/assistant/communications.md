# Communications Runtime

This runtime now treats phone calls and text messaging as first-class concepts through a local communications store plus a Vonage adapter.

## What Exists

- `src/services/communications-store.ts` persists calls and messages under `~/.openelinaro/communications/store.json`
- `src/services/vonage-service.ts` owns Vonage configuration, outbound API calls, webhook verification, and formatting
- `src/services/gemini-live-phone-service.ts` owns Gemini 2.5 Flash Live outbound phone-call sessions, transcript logs, and the Vonage media bridge
- `src/integrations/http/server.ts` exposes the local HTTP listener for Vonage webhooks
- `src/tools/routine-tool-registry.ts` exposes root-only communications tools:
  - `communications_status`
  - `make_phone_call`
  - `call_list`
  - `call_get`
  - `call_control`
  - `message_send`
  - `message_list`
  - `message_get`

## Webhook Surface

When `src/index.ts` boots, it now starts a Bun HTTP server alongside Discord.

The default webhook paths are:

- Voice answer: `GET /webhooks/vonage/voice/answer`
- Voice event: `GET /webhooks/vonage/voice/event`
- Voice fallback: `GET /webhooks/vonage/voice/fallback`
- Live voice bridge: `WSS /webhooks/vonage/voice/live/:sessionId`
- Messages inbound: `POST /webhooks/vonage/messages/inbound`
- Messages status: `POST /webhooks/vonage/messages/status`

Use the `communications_status` tool to render the exact public URLs from the current environment.

## Local State

Communications state is local-first and lives in:

- `~/.openelinaro/communications/store.json`
- `~/.openelinaro/communications/live-calls/<sessionId>/session.json`
- `~/.openelinaro/communications/live-calls/<sessionId>/transcript.log`

The store keeps:

- call records keyed by Vonage call UUID
- message records keyed by Vonage message UUID or a local fallback id
- recent webhook/API events attached to each call or message record

This is the local history surface for:

- inbound calls seen through the answer/event/fallback webhooks
- outbound calls created through the runtime
- inbound message webhooks
- outbound messages sent through the runtime
- message status webhooks
- Gemini-managed live phone calls placed through `make_phone_call`, including their transcript logs
- per-call latency profiling for setup, turn timing, and audio stream health

## Configuration

The main settings live in `~/.openelinaro/config.yaml`:

- `core.http.host`
- `core.http.port`
- `communications.publicBaseUrl`
- `communications.vonage.applicationId`
- `communications.vonage.privateKeySecretRef`
- `communications.vonage.signatureSecretRef`
- `communications.vonage.defaultFromNumber`
- `communications.vonage.defaultMessageFrom`
- `communications.vonage.defaultMessageChannel`
- `communications.vonage.voiceRegion`
- `communications.vonage.voiceApiBaseUrl`
- `communications.vonage.messagesApiBaseUrl`
- `communications.vonage.webhookBasePath`
- `communications.vonage.secretProfileId`
- `communications.geminiLive.apiKeySecretRef`
- `communications.geminiLive.secretProfileId`
- `communications.geminiLive.model`
- `communications.geminiLive.voiceName`

The default secret refs are:

- private key: `vonage.private_key`
- webhook signature secret: `vonage.signature_secret`
- Gemini API key: `gemini.apiKey`

## Current Behavior

- Outbound calls use the configured Vonage application id plus the RSA private key from the encrypted secret store.
- Outbound messages also use the same application keypair flow.
- `make_phone_call` creates an outbound Vonage call whose media leg is bridged to Gemini 2.5 Flash Live over WebSockets.
- Live calls now start from a humanized default system prompt and append the operator-provided instructions from `make_phone_call`.
- The live bridge now sends a generic "callee answered" start signal, and Gemini generates its own first line from the operator instructions instead of using a fixed scripted opener.
- The live session is tuned for lower latency by disabling Gemini thinking for phone calls and using more aggressive server-side speech endpointing.
- The current default Gemini server-side endpointing for live calls is `prefixPaddingMs=20` and `silenceDurationMs=100`.
- The live call bridge sends 16 kHz PCM from Vonage into Gemini, downsamples Gemini's 24 kHz audio output back to 16 kHz for telephony, and appends input/output transcriptions to the session transcript log while the call is running.
- The bridge auto-hangs up locally after a short delay when Gemini says a configured closing phrase such as `bye` or `goodbye`, instead of relying on Gemini function-calling support.
- Each live-call `session.json` now also carries latency profiling data:
  - setup milestones such as call creation, ringing, answer, Vonage websocket open, Gemini websocket open, and first assistant transcript/audio
  - stream health counters for inbound/outbound packet counts, byte counts, average/max inter-packet gaps, and average/max chunk durations
  - pending-queue peak depth metrics so operators can verify the local bridge is not buffering significant audio before Gemini sees it
  - estimated input-latency breakdown metrics that separate post-speech endpointing wait from residual recognition/processing delay using the configured silence-duration budget
- response-latency breakdown metrics that separate caller-to-first-assistant-transcript generation time from assistant-transcript-to-first-audio speech-output time
- turn timing for speech-like caller audio to first/final transcript plus caller-final-audio to assistant first transcript/audio
- Voice answer and fallback webhooks currently return a simple `talk` NCCO with a configurable default message.
- `call_control` currently supports live-call TTS, stopping TTS, streaming audio, stopping audio, and transfer.
- Inbound message and message-status webhooks are persisted locally and acknowledged with `200`.
- If the webhook signature secret is configured, the runtime verifies Vonage webhook bearer tokens before marking the event as verified.

## Read Next

- Runtime model: [runtime-domain-model.md](runtime-domain-model.md)
- Repo map: [repo-layout.md](repo-layout.md)
- Tool behavior: [tool-use-playbook.md](tool-use-playbook.md)
