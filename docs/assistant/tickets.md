# Tickets Tooling

OpenElinaro can talk to the external Elinaro Tickets tracker through dedicated runtime tools.

## Tools

- `tickets_list`: list tickets with optional status, priority, label, query, and sort filters; defaults to active/open statuses and hides closed states like `done` and `wontfix` unless you include them explicitly in `statuses`
- `tickets_get`: fetch one ticket by id
- `tickets_create`: create a ticket
- `tickets_update`: update title, description, status, priority, or labels

These tools are available in chat and direct runtime flows, and are also visible to coding planner/worker scopes through tool search or direct activation.

## Configuration

The tickets client lives under `~/.openelinaro/config.yaml` plus `~/.openelinaro/secret-store.json`.

Required:

- `tickets.tokenSecretRef` should resolve to a stored API token such as `tickets.apiToken`
- One transport:
  - `tickets.apiUrl`: direct HTTP base URL for the tickets app
  - `tickets.sshTarget`: SSH host or alias for opening a short-lived tunnel to the private tickets service

Optional:

- `tickets.remotePort`: remote private port for SSH tunneling. Defaults to `3011`.
