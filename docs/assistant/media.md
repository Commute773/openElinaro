# Media Runtime

Use this when you need the current answer to "what does OpenElinaro know about local media?"

## Capability

Media is a first-class local subsystem on Darwin only.

- Linux does not expose media tools or media runtime context.
- On Darwin, the assistant can list speakers and target playback to a named speaker.
- On Darwin, the assistant can play a local song or ambience track, then pause, stop, inspect status, or change playback volume.
- On supported hosts, playback is managed through local `mpv` processes with one IPC socket per speaker.

## Library Sources

The runtime builds its media library from:

- `media/` under the runtime root

If `media/catalog.json` exists, its track ids/tags are used. If it does not exist, the runtime synthesizes media entries from file paths and filenames.

The catalog file must use the flat `tracks` schema. Do not use a grouped schema with top-level `songs`/`ambience`/`videos` keys — the runtime ignores those.

```json
{
  "tracks": [
    { "title": "Song Title", "file": "songs/file.mp3", "category": "song", "tags": ["tag1"] },
    { "title": "Ambience", "file": "ambience/rain.mp3", "category": "ambience", "tags": ["rain"] }
  ]
}
```

The filename must be `catalog.json` (American spelling), not `catalogue.json`.

Current intent:

- `song` means music tracks
- `ambience` means looping environmental/background audio such as thunder or rain

The runtime-local `media/ambience/thunder.mp3` track is indexed explicitly so "thunder noises" is always available even without a catalog file.

## Speaker Sources

Speaker aliases and preferred names come from:

- `~/.openelinaro/media/speakers.json`
- Legacy fallback: `~/.openclaw/workspace/skills/play-sound/references/speakers.json` (used only when the native path does not exist; logs a warning)

Live output availability comes from the local audio device list. This is how the app can detect speakers such as `B06HD`.

## Runtime State

Managed playback state lives under `~/.openelinaro/media/`:

- `~/.openelinaro/media/players/` for per-speaker playback metadata
- `~/.openelinaro/media/logs/` for player stdout/stderr logs

`mpv` IPC sockets intentionally live under a short path in the local temp directory rather than under the repo checkout. This avoids Darwin Unix-socket path-length failures in managed-service release snapshots while keeping player metadata and logs under `~/.openelinaro/media/`.

## Tools

- `media_list`
- `media_list_speakers`
- `media_play`
- `media_pause`
- `media_stop`
- `media_set_volume`
- `media_status`
