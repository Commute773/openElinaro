export const PHONE_CALL_BACKENDS = ["gemini-live"] as const;

export type PhoneCallBackend = (typeof PHONE_CALL_BACKENDS)[number];

export function normalizePhoneCallBackend(value: unknown): PhoneCallBackend | null {
  return typeof value === "string" && (PHONE_CALL_BACKENDS as readonly string[]).includes(value)
    ? value as PhoneCallBackend
    : null;
}
