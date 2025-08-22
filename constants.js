import * as os from 'os';
import * as path from 'path';

export const SERVER_NAME = 'dotnetdc';
export const PACKAGE_VERSION = '0.1.4';

export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? '5000');
export const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? '2');
export const MAX_FILES = Number(process.env.MAX_FILES ?? '5000');
export const MAX_BYTES = Number(process.env.MAX_BYTES ?? String(50 * 1024 * 1024));
export const CACHE_ROOT = path.join(os.tmpdir(), 'dotnetdc-cache');


