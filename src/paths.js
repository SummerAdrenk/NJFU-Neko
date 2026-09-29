import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME = path.join(ROOT, 'runtime');
export const LOG_DIR = path.join(RUNTIME, 'logs');
export const EVENTS_FILE = path.join(LOG_DIR, 'events.jsonl');
export const MEMORY_FILE = path.join(RUNTIME, 'memory.json');
export const AFFECTION_FILE = path.join(RUNTIME, 'affection.json');
export const CHESTS_FILE = path.join(RUNTIME, 'chests.json');
export const REQUESTS_FILE = path.join(RUNTIME, 'requests.json');
export const HOME_FILE = path.join(RUNTIME, 'home.json');
export const CONTROL_FILE = path.join(RUNTIME, 'control.json');
export const WATCH_CURSOR_FILE = path.join(RUNTIME, 'watch-cursor.json');
export const AUTH_DIR = path.join(RUNTIME, 'auth');
export const TMP_DIR = path.join(RUNTIME, 'tmp');
