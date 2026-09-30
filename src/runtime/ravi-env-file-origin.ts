/**
 * Tracks env values that were copied into a process env from a Ravi env file.
 *
 * The CLI and daemon load `~/.ravi/.env` into `process.env` at startup, so a
 * plain `process.env[key]` check cannot tell a file value from one inherited
 * from the shell, pm2, or the daemon launcher. Loaders record what they copied
 * here; `ravi runtime env` treats a key as process-present only when its
 * current value did not come from the managed file.
 *
 * Dependency-free on purpose: `src/cli/env.ts` imports it before anything else.
 */

type FileSourcedValue = { value: string; path: string };

const fileSourcedByEnv = new WeakMap<object, Map<string, FileSourcedValue>>();

export function markRaviEnvFileSourced(env: object, key: string, value: string, path: string): void {
  let entries = fileSourcedByEnv.get(env);
  if (!entries) {
    entries = new Map();
    fileSourcedByEnv.set(env, entries);
  }
  entries.set(key, { value, path });
}

export function clearRaviEnvFileSourced(env: object, key: string): void {
  fileSourcedByEnv.get(env)?.delete(key);
}

/** True when `env[key]` still holds the value copied from the env file at `path`. */
export function isRaviEnvFileSourced(env: Record<string, string | undefined>, key: string, path: string): boolean {
  const entry = fileSourcedByEnv.get(env)?.get(key);
  return entry !== undefined && entry.path === path && env[key] === entry.value;
}
