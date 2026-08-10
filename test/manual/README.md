# Manual mTLS test harness

Opt-in integration tests for client certificate support. **Not part of `npm test`** — these
need generated certificates and bind a port, while `npm test` must stay hermetic.

The automated suite (`test/aem.cert-fetch.test.js`) covers every validation failure path and the
"no certificate configured" contract. It cannot cover a real TLS handshake: that needs a genuine
keypair, and committed fixtures expire. That gap is what this directory fills.

## Setup

```bash
bash test/manual/gen-certs.sh      # writes test/manual/certs/ (gitignored)
node test/manual/mtls-server.mjs   # https://localhost:14502
```

`gen-certs.sh` wipes and recreates `certs/` on every run. Contents:

- `ca.pem` / `ca.key` — the throwaway CA the stub trusts
- `server.pem` / `server.key` — stub's own certificate, SAN `localhost` + `127.0.0.1`
- `client.pem` / `client.key` — the client certificate, `CN=test-client`
- `client.encrypted.key` — the same key encrypted, passphrase `testpass`
- `untrusted-client.pem` / `.key` — signed by a *different* CA, so the stub must reject it

## Verifying the harness itself

Do this before trusting it to judge any project code. Run from the repo root with the stub
running.

**1 — a valid client certificate is accepted:**

```bash
curl -s --cacert test/manual/certs/ca.pem \
     --cert test/manual/certs/client.pem \
     --key  test/manual/certs/client.key \
     https://localhost:14502/hello
```

Expect HTTP 200 and a JSON echo. The stub logs `clientCN=test-client`.

**2 — no client certificate is rejected** (the negative control that makes every later
`clientCN` line meaningful):

```bash
curl -s --cacert test/manual/certs/ca.pem https://localhost:14502/hello
```

Expect curl to fail on the handshake. The stub logs `handshake rejected: …`.

**3 — a certificate from a foreign CA is rejected**, which distinguishes "our certificate was
accepted" from "any certificate works":

```bash
curl -s --cacert test/manual/certs/ca.pem \
     --cert test/manual/certs/untrusted-client.pem \
     --key  test/manual/certs/untrusted-client.key \
     https://localhost:14502/hello
```

Expect a handshake failure.

## Routes

- `/_204` — 204 with no body, for empty-response handling
- `/_redirect` — 302 with `Location: /_redirected`, for one-hop redirect handling
- anything else — 200 JSON echo of method, path, headers and body

## What the stub logs

One line per request:

```
clientCN=test-client POST /content/x authorization=Basic <redacted> content-type=application/json bodyBytes=42
```

`clientCN` is the proof the handshake presented our certificate. `authorization` is the proof
that application auth still travels alongside it — the two are orthogonal, which is the whole
point of the design. The credential itself is redacted because this prints to a terminal.

## Using it against the MCP server

Once the CLI flags exist:

```bash
node dist/cli.js -H https://localhost:14502 \
  --cert test/manual/certs/client.pem \
  --key  test/manual/certs/client.key \
  --ca   test/manual/certs/ca.pem \
  -u admin -p admin
```

The stub should log both `clientCN=test-client` and `authorization=Basic <redacted>`.

For the encrypted-key path, use `client.encrypted.key` and export
`AEM_KEY_PASSPHRASE=testpass`. There is deliberately no CLI flag for the passphrase, so it never
appears in `ps aux`.
