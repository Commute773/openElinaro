// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------
export const FS_DEFAULT_READ_LIMIT = 200;
export const FS_DEFAULT_LIST_LIMIT = 200;
export const FS_DEFAULT_GLOB_LIMIT = 200;
export const FS_DEFAULT_GREP_LIMIT = 100;
export const FS_MAX_LINE_LENGTH = 2_000;
export const FS_MAX_READ_BYTES = 50 * 1024;
export const FS_MAX_READ_BYTES_LABEL = `${FS_MAX_READ_BYTES / 1024} KB`;

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const SHELL_COMMAND_PREVIEW_LIMIT = 512;
export const SHELL_DEFAULT_NOTIFICATION_TAIL_LINES = 20;

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
export const DISCORD_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const DISCORD_MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
export const DEFAULT_PROFILE_ID = "root";
