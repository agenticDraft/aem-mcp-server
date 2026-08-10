/**
 * Client certificate (mTLS) material loading and host validation for the AEM leg.
 *
 * Only node:fs and node:tls — no network, no AEM knowledge — so the logic stays
 * unit-testable in isolation. Nothing here opens a socket.
 *
 * The certificate configures the TLS *connection*, not the identity: it composes
 * with whatever auth (Basic or OAuth) is already configured rather than replacing
 * it. When no certificate is configured every export here is inert.
 */

import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { createAEMError, AEM_ERROR_CODES } from './aem.errors.js';

/** The subset of CliParams this module reads. CliParams satisfies it structurally. */
export type CertParams = {
  cert?: string;
  key?: string;
  ca?: string;
};

/** Resolved PEM contents, shaped to spread straight into `new https.Agent(...)`. */
export type CertMaterial = {
  cert: string;
  key: string;
  ca?: string;
  passphrase?: string;
};

/** A host paired with whatever the operator would recognise it by. */
export type NamedHost = {
  /** `--host` for the single-instance path, or the instance name from --instances. */
  label: string;
  host: string;
};

const PEM_HEADER = '-----BEGIN ';
const ENCRYPTED_KEY_HEADER = '-----BEGIN ENCRYPTED PRIVATE KEY-----';
const PASSPHRASE_ENV = 'AEM_KEY_PASSPHRASE';

/**
 * Hosts that can never sit behind a Dispatcher demanding a client certificate,
 * so requiring https of them would only break local development. Mirrors the MCP
 * specification's own idiom for OAuth URLs ("reject http:// except for loopback
 * addresses during development").
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

/** Read a PEM file, failing with the flag the operator typed rather than a raw errno. */
function readPem(path: string, flag: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error: any) {
    const code = error?.code === 'ENOENT'
      ? AEM_ERROR_CODES.RESOURCE_NOT_FOUND
      : AEM_ERROR_CODES.INVALID_PARAMETERS;
    throw createAEMError(code, `Cannot read ${flag} at "${path}": ${error?.message || error}.`);
  }

  if (!contents.trimStart().startsWith(PEM_HEADER)) {
    throw createAEMError(
      AEM_ERROR_CODES.INVALID_PARAMETERS,
      `${flag} at "${path}" is not a PEM-encoded file (expected it to start with "${PEM_HEADER}").`,
    );
  }

  return contents;
}

/**
 * Resolve client certificate material from CLI params, or `null` when no
 * certificate is configured — the default path, which must stay inert.
 *
 * Everything that can be checked without a network round trip is checked here,
 * at startup, so a misconfiguration fails immediately and locally instead of as
 * an opaque TLS error on the first tool call.
 */
export function loadCertMaterial(params: CertParams = {}): CertMaterial | null {
  const { cert: certPath, key: keyPath, ca: caPath } = params;

  if (!certPath && !keyPath) {
    // A CA bundle alone cannot present a client certificate. Refuse rather than
    // ignore it, so the operator is never left believing mTLS is configured.
    if (caPath) {
      throw createAEMError(
        AEM_ERROR_CODES.INVALID_PARAMETERS,
        '--ca was provided without --cert and --key. A CA bundle on its own does not enable '
        + 'client certificate authentication and would have no effect.',
      );
    }
    return null;
  }

  if (!certPath || !keyPath) {
    throw createAEMError(
      AEM_ERROR_CODES.INVALID_PARAMETERS,
      `--cert and --key must be provided together (got only ${certPath ? '--cert' : '--key'}).`,
    );
  }

  const cert = readPem(certPath, '--cert');
  const key = readPem(keyPath, '--key');
  const ca = caPath ? readPem(caPath, '--ca') : undefined;
  const passphrase = process.env[PASSPHRASE_ENV] || undefined;

  if (key.includes(ENCRYPTED_KEY_HEADER) && !passphrase) {
    throw createAEMError(
      AEM_ERROR_CODES.INVALID_PARAMETERS,
      `--key at "${keyPath}" is an encrypted private key, but ${PASSPHRASE_ENV} is not set. `
      + `Set ${PASSPHRASE_ENV} in the environment — there is deliberately no CLI flag, so the `
      + 'passphrase never appears in the process list.',
    );
  }

  // Surface a mismatched keypair here rather than as a handshake failure later.
  try {
    createSecureContext({ cert, key, passphrase });
  } catch (error: any) {
    throw createAEMError(
      AEM_ERROR_CODES.INVALID_PARAMETERS,
      `--cert "${certPath}" and --key "${keyPath}" are not a valid keypair: ${error?.message || error}.`,
    );
  }

  return { cert, key, ca, passphrase };
}

/**
 * Refuse to start when a certificate is configured but a host could never receive
 * it. A certificate cannot be presented over plaintext, so the flags would be
 * silently inert and the operator would believe mTLS was active.
 *
 * Inert when `material` is null: with no certificate configured this must never
 * fire, whatever the hosts look like.
 */
export function assertCertHosts(material: CertMaterial | null, hosts: NamedHost[]): void {
  if (!material) return;

  const plaintext = hosts.filter(({ host }) => !host.startsWith('https:') && !LOOPBACK.test(host));
  if (plaintext.length === 0) return;

  const offenders = plaintext.map(({ label, host }) => `${label} (${host})`).join(', ');
  throw createAEMError(
    AEM_ERROR_CODES.INVALID_PARAMETERS,
    `A client certificate is configured, but these hosts are not https://: ${offenders}. `
    + 'The certificate cannot be presented over plaintext HTTP. Loopback hosts are exempt.',
  );
}
