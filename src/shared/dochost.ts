/**
 * doc_read URL policy. READ-ONLY for module implementers.
 *
 * One home for the rule so the two enforcement points (worktools before it
 * calls dws, dws before it spawns) cannot drift apart — they already had,
 * once, with dws quietly allowing http while worktools required https. A
 * doc_read hands a URL to the dws binary and echoes the result back into chat,
 * so an over-broad host list is an outbound-fetch/exfil channel.
 */

export type DocHostCheck = { ok: true; url: URL } | { ok: false; message: string };

export function checkDocHost(docHosts: readonly string[], docUrl: string): DocHostCheck {
  let url: URL;
  try {
    url = new URL(docUrl);
  } catch {
    return { ok: false, message: "that is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: `only https doc links are allowed, not "${url.protocol}"` };
  }
  const host = url.hostname.toLowerCase();
  if (!docHosts.some((allowed) => allowed.toLowerCase() === host)) {
    return { ok: false, message: `"${host}" is not an allowed doc host` };
  }
  return { ok: true, url };
}
