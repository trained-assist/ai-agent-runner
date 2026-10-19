// OpenCode IDs use 12 lowercase hex timestamp digits plus 14 base62 characters.
// Retain the older ULID-shaped IDs already accepted by persisted Runner records.
const SESSION_ID = '(?:[a-f0-9]{12}[A-Za-z0-9]{14}|[0-7][0-9A-HJKMNP-TV-Z]{25})';
export const OPENCODE_SESSION_ID = new RegExp(`^ses_${SESSION_ID}$`);
export const OPENCODE_CHECKPOINT_PATH = new RegExp(`^\\.session-traces/(ses_${SESSION_ID})\\.json$`);
