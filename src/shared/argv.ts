/**
 * Safe argv construction for the `dws` CLI. READ-ONLY for module implementers.
 *
 * We never build a shell string, so there is no shell injection here. The risk
 * is narrower and easier to miss: a model-supplied VALUE that begins with `-`
 * is handed to dws's own option parser and read as a FLAG, not as data. One
 * attacker-chosen token like `--output=/somewhere` is enough, because
 * `--flag=value` is a single argv element.
 *
 * The defence is structural rather than a reminder to be careful: callers
 * cannot hand us a bare string in a value position. They pass command tokens
 * and [flag, value] pairs separately, and this module proves each is what it
 * claims to be before anything is spawned.
 */

/** Subcommand tokens, e.g. "chat", "+messages-send", "event". Never user data. */
const COMMAND_RE = /^\+?[a-z][a-z0-9-]*$/;
/** Option names, e.g. "--text", "-f". Never user data. */
const FLAG_RE = /^--?[a-z][a-z0-9-]*$/;

export type Flag = [flag: string, value: string];

/** Thrown instead of spawning. A caller that trips this has a bug, and the
 * only safe response to "this value might be a flag" is to not run at all. */
export class UnsafeArgvError extends Error {}

export function assertCommandToken(token: string): string {
  if (!COMMAND_RE.test(token)) throw new UnsafeArgvError(`unsafe dws command token: ${JSON.stringify(token)}`);
  return token;
}

export function assertFlagName(flag: string): string {
  if (!FLAG_RE.test(flag)) throw new UnsafeArgvError(`unsafe dws flag: ${JSON.stringify(flag)}`);
  return flag;
}

/**
 * A value is safe when dws's parser cannot mistake it for an option. That
 * means: not starting with `-`, and no NUL. Everything else — spaces, quotes,
 * newlines, CJK, emoji — is fine, because spawn passes the array straight to
 * execve without a shell.
 */
export function assertValue(flag: string, value: string): string {
  if (value.includes("\0")) throw new UnsafeArgvError(`value for ${flag} contains a NUL byte`);
  if (value.startsWith("-")) {
    throw new UnsafeArgvError(`value for ${flag} starts with "-" and would be parsed as an option`);
  }
  return value;
}

/** The same rule as assertValue, as a boolean — delegated so there is one
 * source of truth. For callers that refuse politely with ok:false. */
export function isSafeValue(value: string): boolean {
  try {
    assertValue("", value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a validated argv. `command` is the fixed subcommand path, `flags` are
 * the [flag, value] pairs. Values are checked; a rejected value throws before
 * any process is spawned.
 */
export function dwsArgv(command: string[], flags: Flag[] = []): string[] {
  const argv = command.map(assertCommandToken);
  for (const [flag, value] of flags) {
    argv.push(assertFlagName(flag), assertValue(flag, value));
  }
  return argv;
}
