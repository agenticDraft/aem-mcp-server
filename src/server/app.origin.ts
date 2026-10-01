/**
 * Origin validation for the http transport (MCP Streamable HTTP, "Security &
 * Endpoint": servers MUST validate Origin to prevent DNS rebinding, and answer
 * 403 when it is present and invalid).
 *
 * Pure: no Express, no network, so the rules are unit-testable on their own.
 */

/** Result of parsing --allowedOrigins: either "allow everything" or exact origins. */
export type AllowedOrigins = {
  any: boolean;
  origins: Set<string>;
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Canonical `scheme://host[:port]`, or null when the value is not an http(s) origin. */
function toOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/**
 * Parse a comma-separated list of origins. `*` disables the check.
 * Throws on an entry that is not a bare origin, so a typo fails at startup
 * instead of silently rejecting the client it was meant to allow.
 */
export function parseAllowedOrigins(value: string | undefined): AllowedOrigins {
  const entries = (value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.includes('*')) return { any: true, origins: new Set() };

  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = toOrigin(entry);
    // URL() accepts a path; an origin must not have one ("/" alone is fine).
    const hasPath = origin !== null && new URL(entry).pathname !== '/';
    if (!origin || hasPath) {
      throw new Error(
        `--allowedOrigins entry "${entry}" is not a valid origin. `
        + 'Expected scheme://host[:port], e.g. https://tools.example.com',
      );
    }
    origins.add(origin);
  }
  return { any: false, origins };
}

/**
 * A request is allowed when it has no Origin (non-browser clients send none),
 * comes from a loopback origin, or matches the allowlist exactly.
 */
export function isOriginAllowed(origin: string | undefined, allowed: AllowedOrigins): boolean {
  if (!origin) return true;
  if (allowed.any) return true;

  const canonical = toOrigin(origin);
  if (!canonical) return false;

  if (LOOPBACK_HOSTNAMES.has(new URL(canonical).hostname)) return true;
  return allowed.origins.has(canonical);
}
