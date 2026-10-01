/** Narrowing helpers for parsed JSON, shared by the ICA HTTP modules. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A non-blank string, trimmed; anything else is undefined. */
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
