import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imports the compiled output so the suite runs on plain Node (no TS loader).
// `npm test` builds first; CI builds before the test step.
import { parseAllowedOrigins, isOriginAllowed } from '../dist/server/app.origin.js';

const none = parseAllowedOrigins('');

// ---------------------------------------------------------------- no Origin

test('a request without an Origin header is allowed (non-browser clients send none)', () => {
  assert.equal(isOriginAllowed(undefined, none), true);
  assert.equal(isOriginAllowed('', none), true);
});

// ---------------------------------------------------------------- loopback

test('loopback origins are allowed by default, with or without a port', () => {
  for (const origin of [
    'http://localhost',
    'http://localhost:6274',
    'https://localhost:8443',
    'http://127.0.0.1',
    'http://127.0.0.1:8502',
    'http://[::1]',
    'http://[::1]:3000',
  ]) {
    assert.equal(isOriginAllowed(origin, none), true, origin);
  }
});

test('hosts that only look like loopback are rejected', () => {
  for (const origin of [
    'http://localhost.evil.com',
    'http://evil-localhost',
    'http://127.0.0.1.evil.com',
    'http://evil.com:127',
    'http://localhost@evil.com',
  ]) {
    assert.equal(isOriginAllowed(origin, none), false, origin);
  }
});

test('any other origin is rejected by default', () => {
  assert.equal(isOriginAllowed('http://evil.com', none), false);
  assert.equal(isOriginAllowed('https://aem.example.com', none), false);
});

test('the opaque "null" origin and malformed values are rejected', () => {
  assert.equal(isOriginAllowed('null', none), false);
  assert.equal(isOriginAllowed('not a url', none), false);
  assert.equal(isOriginAllowed('file:///etc/passwd', none), false);
});

// ---------------------------------------------------------------- allowlist

test('an origin on the allowlist is allowed by exact match only', () => {
  const allowed = parseAllowedOrigins('https://tools.example.com, http://intranet:8080');
  assert.equal(isOriginAllowed('https://tools.example.com', allowed), true);
  assert.equal(isOriginAllowed('http://intranet:8080', allowed), true);
  assert.equal(isOriginAllowed('https://tools.example.com:444', allowed), false);
  assert.equal(isOriginAllowed('http://tools.example.com', allowed), false);
  assert.equal(isOriginAllowed('https://evil.tools.example.com', allowed), false);
});

test('allowlist entries are normalised: trailing slash, case, whitespace', () => {
  const allowed = parseAllowedOrigins('  HTTPS://Tools.Example.com/ ,,');
  assert.equal(isOriginAllowed('https://tools.example.com', allowed), true);
});

test('loopback stays allowed when an allowlist is configured', () => {
  const allowed = parseAllowedOrigins('https://tools.example.com');
  assert.equal(isOriginAllowed('http://localhost:6274', allowed), true);
});

test('"*" allows every origin', () => {
  const any = parseAllowedOrigins('*');
  assert.equal(isOriginAllowed('http://evil.com', any), true);
  assert.equal(isOriginAllowed('null', any), true);
});

test('an allowlist entry that is not an origin is refused at startup', () => {
  assert.throws(() => parseAllowedOrigins('tools.example.com'), /not a valid origin/);
  assert.throws(() => parseAllowedOrigins('https://tools.example.com/path'), /not a valid origin/);
});
