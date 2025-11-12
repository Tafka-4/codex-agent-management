## Codex Agent Management API

This service exposes a REST API for managing Codex automation sessions and a WebSocket gateway for streaming live task updates to clients. It runs entirely in-memory, making it ideal for local development and rapid prototyping of the CTF automation workflow.

### Getting started

```
npm install
npm run dev
```

- `npm run dev` starts the API with hot-loaded TypeScript via `ts-node`.
- `npm start` compiles to `dist/` and launches the compiled JavaScript.

Set a Codex API token before starting the service:

```
export CODEX_API_KEY=sk-...
```

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `CODEX_BASE_URL` | Custom Codex endpoint (defaults to the public service). |
| `CODEX_WORKING_DIRECTORY` | Directory where the Codex agent executes commands (defaults to the API project path). |
| `CODEX_SANDBOX_MODE` | Codex sandbox (`read-only`, `workspace-write`, `danger-full-access`). |
| `CODEX_APPROVAL_POLICY` | Codex approval mode (`never`, `on-request`, `on-failure`, `untrusted`). |
| `CODEX_NETWORK_ACCESS` | `"true"` to enable network access. |
| `CODEX_WEB_SEARCH` | `"true"` to allow web search tool usage. |
| `CODEX_MODEL` | Override the model selection. |
| `CODEX_MODEL_REASONING_EFFORT` | `minimal`, `low`, `medium`, or `high`. |
| `WORKSPACE_ROOT` | Base directory for per-challenge workspaces (defaults to `~/workspace`). |
| `AGENT_MAX_CONCURRENCY` | Maximum number of concurrent Codex runs (defaults to `4`). |

The server listens on `http://localhost:3000` by default. Override the port with `PORT=<number>`.

### REST endpoints

Base path: `/api`.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/session` | Create a new Codex session and kick off the bootstrap workflow. |
| `GET` | `/api/session/:id` | Retrieve the latest snapshot (status + event history) for a session. |
| `DELETE` | `/api/session/:id` | Cancel an active session; WebSocket clients are notified and disconnected. |
| `POST` | `/api/session/:id/hint` | Provide an operator hint; the agent resumes the thread with the supplied guidance. |

`POST /api/session/:id/hint` expects:

```json
{
  "hint": "Try fuzzing the input parser with larger payloads."
}
```

**Request body (`POST /api/session`):**

```json
{
  "probCategory": "pwn",
  "probTitle": "Heap playground",
  "probDescription": "Simple heap exploitation challenge",
  "probFile": "optional-base64-blob"
}
```

**Example curl:**

```bash
curl -X POST http://localhost:3000/api/session \
  -H "content-type: application/json" \
  -d '{
        "probCategory": "web",
        "probTitle": "Auth bypass",
        "probDescription": "Track down the misconfigured middleware"
      }'
```

When a session is created, a per-challenge workspace is prepared at `~/workspace/<sanitized-title>/`.
The uploaded archive (if any) is written to `prob.zip` within that directory, and the Codex agent runs from that location.

Response payloads now include:

```json
{
  "session": {
    "id": "f9ed41b8-...",
    "status": "running",
    "threadId": "thread_abc123",
    "result": null,
    "error": null,
    "createdAt": 1730052487123,
    "updatedAt": 1730052487123,
    "problem": {
      "category": "web",
      "title": "Auth bypass",
      "description": "..."
    },
    "workspacePath": "/Users/alice/workspace/auth-bypass",
    "artifactPath": "/Users/alice/workspace/auth-bypass/prob.zip",
    "events": []
  }
}
```

`result` is populated with the agent's structured output once a turn finishes. The field includes the final inference status (`solved`, `awaiting_hint`, or `failed`), any recovered flag, a summary, solution artifacts, and a list of next steps if the agent requires hints.

### WebSocket streaming

Clients receive real-time updates by connecting to:

```
ws://localhost:3000/ws/session/<sessionId>
```

* A snapshot containing the full session state is delivered immediately after connecting.
- Subsequent messages are streamed as JSON objects:
  - `{"type":"status","status":"running","timestamp":...}`
  - `{"type":"event","event":{ ... detailed task payload ... }}`
  - `{"type":"agent_result","result":{ ... structured Codex output ... }}`
- Send `{"type":"ping"}` to receive a `{"type":"pong","timestamp":...}` heartbeat (optional – standard WebSocket pings are also supported).

Session snapshots now include `workspacePath` and `artifactPath`, allowing clients to locate artifacts on disk.

If a session is deleted, the server pushes a final snapshot and closes all sockets with code `1000`.

### Development notes

- Session and task data are stored in-memory; restarting the process clears everything.
- Codex runs with the provided sandbox configuration and streams progress events (`command_execution`, `todo_list`, `file_change`, `agent_message`, etc.) directly to connected clients.
- Operator hints can be posted to `/api/session/:id/hint` and are processed once a concurrency slot becomes available. A maximum of four agent runs execute simultaneously by default (configurable via `AGENT_MAX_CONCURRENCY`).
- Structured responses drive the lifecycle:
  - `inferenceStatus: "solved"` → session status transitions to `completed` and any recovered flag/solution files are emitted.
  - `inferenceStatus: "awaiting_hint"` or agent errors → session status transitions to `awaiting_hint` so operators know to provide additional guidance.
- Add persistence or message-queue integrations inside `SessionManager` to fan out events across multiple API instances if you need horizontal scale.
