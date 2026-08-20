/**
 * Environment scrubbing for spawned children. READ-ONLY for module implementers.
 *
 * The invariant is security-relevant and must have ONE home, not a copy per
 * spawn site: a child process must NEVER inherit the daemon's own secret
 * namespace (DOUSHABAO_TOKEN, DOUSHABAO_ROOT, ...). Callers pass the extra keys
 * and prefixes their particular child legitimately needs; everything else,
 * and the whole DOUSHABAO_* namespace unconditionally, is dropped.
 *
 * NOTE: this is NOT for the pi child — pi's extension reads DOUSHABAO_* by
 * design (the IPC contract), so src/pi builds its env the other way, passing
 * process.env through. Only dws-family children go through here.
 */

/** The daemon's own namespace. Never leaves the process, whatever a caller
 * allowlists. */
const SECRET_PREFIX = "DOUSHABAO_";

export function allowlistedEnv(keys: readonly string[], prefixes: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith(SECRET_PREFIX)) continue;
    if (keys.includes(key) || prefixes.some((p) => key.startsWith(p))) env[key] = value;
  }
  return env;
}

/** Proxy/TLS transport vars a network child (dws, git push) needs to reach the
 * outside world on hosts behind a corporate proxy or a custom CA. Dropping
 * these silently breaks connectivity on such hosts, so every network-spawn
 * allowlist includes them. */
export const NET_TRANSPORT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/** The env a `dws` child receives — ONE source of truth for the two modules
 * that spawn dws (the adapter and worktools), so they cannot drift. Never the
 * daemon's DOUSHABAO_* secrets; always PATH/HOME, dws/DingTalk config, the
 * FAKE_DWS_* test protocol, and network transport vars. */
export function dwsChildEnv(): Record<string, string> {
  return allowlistedEnv(
    ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", ...NET_TRANSPORT_KEYS],
    ["DWS_", "DINGTALK_", "FAKE_DWS_"],
  );
}
