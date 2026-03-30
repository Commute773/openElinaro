# Assistant Docs

These docs describe the current agent system architecture and runtime behavior.

## Core Architecture

- [Repo Layout](repo-layout.md) -- directory structure and system boundaries
- [Architecture Decisions](architecture-decisions.md) -- key design decisions shaping the codebase
- [Runtime Domain Model](runtime-domain-model.md) -- core types, profiles, auth, projects, routines
- [Configuration](configuration.md) -- config files, feature flags, onboarding

## Runtime Systems

- [Autonomous Time & Reflection](reflection.md) -- unified autonomous time, journal, soul rewrites
- [Memory](memory.md) -- durable memory, structured entities, identity continuity
- [Communications](communications.md) -- phone calls, messaging, Vonage/Gemini Live
- [Media](media.md) -- local audio playback, speakers, media library
- [Tickets](tickets.md) -- external Elinaro Tickets tracker integration

## Agent Behavior

- [Tool Use Playbook](tool-use-playbook.md) -- tool discovery, web ladder, browser secrets, patterns
- [Decision Support](decision-support.md) -- guidance style, spending and impulse management
- [Observability](observability.md) -- telemetry, logging, model usage ledger

## Platform Surface

- [HTTP API](api.md) -- JSON API endpoints, generated routes, client codegen
- [Projects](projects.md) -- project registry, per-project docs, workspace conventions
- [Extensions](extensions.md) -- user-installed extension modules (discovery/validation implemented, activation stubbed)

User-specific persona and operator docs are loaded from `~/.openelinaro/docs/assistant/`, not from this repo.
