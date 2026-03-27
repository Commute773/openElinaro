# G2 API

The G2 API is an HTTP JSON API served by the main runtime on the same port as the health and webhook endpoints. It provides programmatic access to the agent's home dashboard, routines, todos, notifications, running agents, and a chat interface.

All endpoints live under `/api/g2/` and are handled by [`src/integrations/http/g2-api.ts`](../../src/integrations/http/g2-api.ts). The HTTP server is started by [`src/integrations/http/server.ts`](../../src/integrations/http/server.ts) using `Bun.serve()`.

## Configuration

The HTTP server is configured in `~/.openelinaro/config.yaml` under `core.http`:

```yaml
core:
  http:
    host: "0.0.0.0"   # default
    port: 3000         # default
```

There is currently no authentication layer on the G2 API. Access control is expected to be handled at the network level (e.g. firewall, reverse proxy).

## CORS

All G2 responses include permissive CORS headers (`Access-Control-Allow-Origin: *`). `OPTIONS` preflight requests to any `/api/g2` path return `204 No Content` with the same CORS headers.

## Endpoints

### GET /api/g2/home

Dashboard summary: time context, active agent count, best routine streak, next upcoming routine, and pending notification count.

```sh
curl http://localhost:3000/api/g2/home
```

Response:

```json
{
  "timeContext": "Friday morning, 2026-03-27",
  "activeAgentCount": 2,
  "streak": 5,
  "nextRoutine": { "name": "Morning review", "time": "08:00", "type": "routine" },
  "pendingNotificationCount": 1
}
```

`nextRoutine` is `null` when no upcoming routine exists.

### GET /api/g2/agents

List currently running or starting background agents.

```sh
curl http://localhost:3000/api/g2/agents
```

Response:

```json
[
  {
    "id": "abc123",
    "status": "RUNNING",
    "host": "openelinaro",
    "uptime": "1h 23m",
    "goal_truncated": "Refactor the config module to support nested keys"
  }
]
```

### GET /api/g2/agents/:id/output

Capture recent terminal output from a running agent.

| Param | Location | Default | Description |
|-------|----------|---------|-------------|
| `id` | path | required | Agent run ID |
| `lines` | query | `20` | Number of lines to capture |

```sh
curl "http://localhost:3000/api/g2/agents/abc123/output?lines=50"
```

Response:

```json
{
  "runId": "abc123",
  "output": ["line 1", "line 2", "..."]
}
```

### POST /api/g2/agents/:id/send

Send input text to a running agent (steer it).

```sh
curl -X POST http://localhost:3000/api/g2/agents/abc123/send \
  -H "Content-Type: application/json" \
  -d '{"input": "Focus on the failing test first"}'
```

Request body: `{ "input": "<text>" }` (required).

Response: `{ "ok": true }`

### GET /api/g2/routines

List active scheduled routines with their current status.

```sh
curl http://localhost:3000/api/g2/routines
```

Response:

```json
[
  { "id": "r1", "name": "Morning review", "time": "08:00", "status": "done" },
  { "id": "r2", "name": "Evening journal", "time": "21:00", "status": "pending" }
]
```

Status is one of `done`, `pending`, or `missed`. Items are sorted by time.

### POST /api/g2/routines/:id/done

Mark a routine as done.

```sh
curl -X POST http://localhost:3000/api/g2/routines/r1/done
```

Response: `{ "ok": true }`

### GET /api/g2/todos

List active todo items.

```sh
curl http://localhost:3000/api/g2/todos
```

Response:

```json
[
  { "id": "t1", "title": "Review PR #99", "status": "active", "priority": 1 }
]
```

### POST /api/g2/todos/:id/done

Mark a todo as done.

```sh
curl -X POST http://localhost:3000/api/g2/todos/t1/done
```

Response: `{ "ok": true }`

### POST /api/g2/ask

Send a chat message to the agent and receive a response.

```sh
curl -X POST http://localhost:3000/api/g2/ask \
  -H "Content-Type: application/json" \
  -d '{"text": "What is on my schedule today?"}'
```

Request body: `{ "text": "<message>" }` (required).

Response: `{ "response": "You have two routines remaining today..." }`

The request is processed on the `g2-simulator` conversation key.

### GET /api/g2/notifications

List pending notifications (overdue routines and due alarms).

```sh
curl http://localhost:3000/api/g2/notifications
```

Response:

```json
[
  {
    "id": "routine:r2",
    "type": "routine",
    "title": "Evening journal",
    "body": "routine -- 15m overdue",
    "actions": ["done", "snooze", "dismiss"]
  },
  {
    "id": "alarm:a1",
    "type": "timer",
    "title": "Laundry timer",
    "body": "Timer: 30m",
    "actions": ["done", "snooze", "dismiss"]
  }
]
```

Up to 10 routine notifications and 5 alarm notifications are returned.

### POST /api/g2/notifications/:id/action

Act on a notification. The notification ID format is `<type>:<itemId>` (e.g. `routine:r2` or `alarm:a1`).

```sh
curl -X POST http://localhost:3000/api/g2/notifications/routine:r2/action \
  -H "Content-Type: application/json" \
  -d '{"action": "done"}'
```

Request body: `{ "action": "done" | "snooze" | "dismiss" }`. Defaults to `dismiss` if omitted.

- **done** -- marks the routine complete or the alarm delivered.
- **snooze** -- snoozes a routine for 15 minutes (not supported for alarms).
- **dismiss** -- acknowledges without acting.

Response: `{ "ok": true }`

## Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "input is required" }
```

Client errors return `400`, server errors return `500`.

## Other HTTP Endpoints

The same server also handles:

- `GET /healthz` -- returns `{ "ok": true }` for liveness probes.
- Vonage voice and messaging webhooks under the configured `webhookBasePath` (default `/webhooks/vonage`).

These are separate from the G2 API and documented in [communications.md](communications.md) and [configuration.md](configuration.md).

## Read Next

- Configuration and HTTP setup: [configuration.md](configuration.md)
- Runtime domain model: [runtime-domain-model.md](runtime-domain-model.md)
- Extensions: [extensions.md](extensions.md)
