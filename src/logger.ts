import pino, { type DestinationStream } from 'pino';

const REDACT = { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.personnummer', '*.access_token', '*.refresh_token'], censor: '<redacted>' };
/** The app logger; `destination` (tests) receives every line as JSON text instead of stdout. */
export const createLogger = (level: string, destination?: DestinationStream) => (destination ? pino({ level, redact: REDACT }, destination) : pino({ level, redact: REDACT }));
export type Logger = ReturnType<typeof createLogger>;
