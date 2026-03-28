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
export const DISCORD_MESSAGE_LIMIT = 1_900;
export const DISCORD_TYPING_REFRESH_MS = 8_000;
export const DISCORD_DM_BATCH_TIMEOUT_MS = 5 * 60 * 1000;
export const DISCORD_MAX_TEXT_ATTACHMENT_CHARS = 32_000;
export const DISCORD_CONTINUED_SUFFIX = "/continued";

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
export const COMPACTION_THRESHOLD_PERCENT = 80;
export const CHAT_MAX_STEPS = 24;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export const TOOL_RESULT_INLINE_CHAR_THRESHOLD = 1_000;
export const TOOL_SUMMARY_KEY_LIMIT = 4;
export const TOOL_SUMMARY_LIST_LIMIT = 2;
export const TOOL_SUMMARY_TEXT_LIMIT = 40;
export const TOOL_OUTPUT_CHAR_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Web fetch
// ---------------------------------------------------------------------------
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
export const DEFAULT_EMAIL_TIMEOUT_MS = 20_000;
export const DEFAULT_EMAIL_LIST_LIMIT = 10;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------
export const MEMORY_RECALL_LIMIT = 3;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
export const DEFAULT_PROFILE_ID = "root";
