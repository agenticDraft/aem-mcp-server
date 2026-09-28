#!/usr/bin/env node
/**
 * OAuth S2S + client certificate, end to end through AEMConnector, without real
 * Adobe IMS credentials.
 *
 * The IMS token call (src/aem/aem.auth.ts) uses global fetch; the AEM leg in cert
 * mode uses node:https. So replacing global fetch with a fake IMS answers the
 * token request while every AEM request still makes a real mTLS handshake with
 * the stub. What this cannot prove is that real IMS accepts real credentials —
 * see "Pending: real IMS credentials" in README.md.
 *
 *   bash test/manual/gen-certs.sh
 *   node test/manual/mtls-server.mjs     # in another terminal
 *   npm run build:ts
 *   node test/manual/smoke-oauth-cert.mjs
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CERTS = join(dirname(fileURLToPath(import.meta.url)), 'certs');
const HOST = `https://localhost:${process.env.PORT || 14502}`;
const CLIENT_ID = 'fake-client-id';
const FAKE_TOKEN = 'fake-ims-access-token';

const imsCalls = [];
const otherGlobalFetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://ims-na1.adobelogin.com/')) {
    imsCalls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ access_token: FAKE_TOKEN, expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  otherGlobalFetchCalls.push(url);
  return realFetch(input, init);
};

// Imported after the patch so every module sees the fake.
const { AEMConnector } = await import('../../dist/aem/aem.connector.js');

const connector = new AEMConnector({
  host: HOST,
  id: CLIENT_ID,
  secret: 'fake-client-secret',
  cert: join(CERTS, 'client.pem'),
  key: join(CERTS, 'client.key'),
  ca: join(CERTS, 'ca.pem'),
});

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

await connector.init();
const result = await connector.getNodeContent('/content/oauth-cert', 1);
const echo = result?.content ?? {};

await check('connector is in OAuth (AEMaaCS) mode', () => {
  assert.equal(connector.isAEMaaCS, true);
});

await check('token came from IMS via global fetch, exactly once, with our client_id', () => {
  assert.equal(imsCalls.length, 1);
  const body = new URLSearchParams(imsCalls[0].body);
  assert.equal(body.get('grant_type'), 'client_credentials');
  assert.equal(body.get('client_id'), CLIENT_ID);
});

await check('AEM request presented the client certificate (stub saw clientCN)', () => {
  assert.equal(echo.clientCN, 'test-client');
});

await check('AEM request carried Authorization: Bearer (credential redacted by the stub)', () => {
  assert.match(String(echo.authorization), /^Bearer /);
});

await check('no AEM request went through global fetch (all used the cert transport)', () => {
  assert.deepEqual(otherGlobalFetchCalls, []);
});

console.log(`\n${passed}/5 passed`);
