# aem-mcp-server — authentication and client certificates

An MCP server that lets an LLM client work with Adobe Experience Manager. It authenticates to AEM with Basic or OAuth Server-to-Server credentials, and it can now present a client certificate when the path to AEM requires one.

**The certificate gets the connection through the gate. AEM still decides who the user is.**

## The problem it solves

Some AEM setups put a Dispatcher or CDN in front of author that demands a client certificate (`SSLVerifyClient require`). Before this change the server had no way to present one. Every tool call failed at the TLS handshake, before AEM ever saw the request, no matter how correct the username, password or OAuth credentials were.

It is tempting to treat the certificate as one more way to log in. It isn't. A certificate proves that this machine may open a connection. It says nothing about which AEM user is acting. Mixing the two leads to configurations that look secure and are not, or that fail with errors nobody can place.

## How it handles it

Three separate questions, answered in three separate places:

1. **Who may call the tools?** Over stdio, whoever launched the process. The MCP client owns it. Over HTTP, the `/mcp` endpoint is currently unauthenticated. A Basic auth middleware exists in the code but is switched off.
2. **Which AEM user acts?** Basic (`-u/-p`) or OAuth Server-to-Server (`-i/-s`), exactly one of them. The credential goes in the `Authorization` header of every request.
3. **Is the connection allowed at all?** The client certificate (`--cert/--key`), presented during the TLS handshake. It is optional, and it is added on top of question 2, not instead of it.

With a certificate configured, the server still sends Basic or Bearer exactly as it would without one. Only the lowest layer changes: the code that opens the connection. Everything above it is shared by both modes: headers, the token refresh on 401, redirects, errors.

A configuration that cannot work stops the server at startup, before any connection is opened. The message names the flag that is wrong:

```
Fatal: --cert and --key must be provided together (got only --cert).
```

```
Fatal: A client certificate is configured, but these hosts are not https://: --host (http://aem.example.com). The certificate cannot be presented over plaintext HTTP. Loopback hosts are exempt.
```

It fails loudly and says why. The alternative is a server that starts fine and then returns an opaque TLS error in the middle of someone's conversation.

## The flow

```
MCP client (Claude Desktop, Cursor, …)
        ↓  stdio  or  HTTP POST /mcp
MCP server  ──  one handler per AEM instance
        ↓
AEMFetch  ──  adds Authorization on every request
        │       Basic base64(user:pass)
        │       Bearer <token>   ←──  Adobe IMS (plain HTTPS, never the certificate)
        ↓
Transport
        ├── no certificate  →  Node fetch                →  AEM
        └── certificate     →  https.Agent (client TLS)  →  Dispatcher / CDN  →  AEM
```

The OAuth token request goes straight to Adobe IMS and never carries the client certificate. The certificate is only for the connection to AEM.

## The auth modes

| Mode | Turned on by | What AEM receives | On a 401 from AEM | Multiple instances |
|---|---|---|---|---|
| **Basic** | Default. `-u/-p`, falling back to `admin:admin` | `Authorization: Basic …` | Retries once with the same credential | Yes: `name:host:user:pass` |
| **OAuth S2S** | `-i` and `-s` both set | `Authorization: Bearer …`, token from Adobe IMS, cached until one minute before it expires | Fetches a new token from IMS and retries once | No. `--instances` has no fields for a client ID or secret |
| **Client certificate** | `--cert` + `--key`, or the `AEM_*_PATH` env vars | A certificate in the TLS handshake, plus one of the two modes above | Not involved. A rejected certificate fails the handshake, not with a 401 | Yes. One certificate for all instances |

OAuth also switches the server into AEM as a Cloud Service mode, which changes which Content Fragment API it calls.

## What it looks like

**A request that passed both gates**

This is the log line of the test stub that stands in for the Dispatcher. The certificate was accepted (`clientCN`), and so was the credential value (`auth=ok`):

```
clientCN=test-client GET /content/oauth-cert.json?%3Adepth=1 authorization=Bearer <redacted> auth=ok
```

**An expired token being replaced**

```
clientCN=test-client GET /content/oauth-cert.json?%3Adepth=1 authorization=Bearer <redacted> auth=rejected
clientCN=test-client GET /content/oauth-cert.json?%3Adepth=1 authorization=Bearer <redacted> auth=ok
```

AEM refused the old token. The server fetched a new one from IMS and retried once, over the same client-certificate connection.

**No certificate at all**

```
handshake rejected: ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE
```

## Running it yourself

### With a client certificate

1. Put the client certificate and its private key where the server can read them, both as PEM files.
2. Keep your normal credentials: `-u/-p` for Basic, or `-i/-s` for OAuth.
3. Add `--cert` and `--key`. Add `--ca` only if AEM's own server certificate is not publicly trusted.
4. If the key is encrypted, set `AEM_KEY_PASSPHRASE` in the environment. There is deliberately no flag for it, so it never shows up in the process list.
5. Start the server. If it starts, the certificate files are valid and every host can receive them.

```json
{
  "mcpServers": {
    "AEM": {
      "command": "npx",
      "args": ["-y", "aem-mcp-server", "-t", "stdio",
               "-H", "https://aem.example.com",
               "-u", "svc-user", "-p", "${AEM_PASSWORD}",
               "--cert", "/etc/certs/client.pem",
               "--key", "/etc/certs/client.key"],
      "env": { "AEM_KEY_PASSPHRASE": "${AEM_KEY_PASSPHRASE}" }
    }
  }
}
```

| Setting | Flag | Environment variable |
|---|---|---|
| Client certificate | `--cert` / `-C` | `AEM_CERT_PATH` |
| Private key | `--key` / `-k` | `AEM_KEY_PATH` |
| CA bundle | `--ca` | `AEM_CA_PATH` |
| Key passphrase | none | `AEM_KEY_PASSPHRASE` |

### Checking it without AEM or real credentials

1. `npm run build:ts`
2. `node test/manual/e2e-cert.mjs`. It generates throwaway certificates and starts its own mTLS stub with mock accounts. It runs 39 checks over stdio and HTTP: valid and invalid certificates, a wrong password, Basic and OAuth with a fake IMS, redirects, and two instances.
3. `node test/manual/regression-auth.mjs --baseline <path to a build of main>`. It runs Basic and OAuth *without* a certificate and compares every request and result, byte for byte, with the previous version. This run: 28 of 28 identical.

Both scripts open local ports, so run them outside any network sandbox. Neither needs a real AEM or a real Adobe account. See [`test/manual/README.md`](test/manual/README.md) for details.

## Limits you should know

- **Scope.** The certificate protects only the connection to AEM. It does not protect this server's own `/mcp` endpoint.
- **Rotation needs a restart.** Certificate files are read once at startup.
- **Redirects.** With a certificate, one redirect hop is followed, not a chain.
- **Revocation.** No CRL or OCSP checking. Handle revocation at the Dispatcher or CDN.
- **No "mTLS on" indicator.** Nothing is logged and `/health` is unchanged. If the server started, the files and hosts passed validation. A certificate that AEM's gate rejects fails on the first tool call.
- **OAuth details.** The IMS region (`ims-na1`) and the default scopes are fixed in code, and multiple instances cannot use OAuth.

> **Not yet verified:** real Adobe IMS credentials against a real AEM as a Cloud Service environment behind a Dispatcher or CDN that checks client certificates. Everything above was tested against a local stub and a faked IMS.

## Why it is built this way

Two rules shaped the change. If you don't configure a certificate, nothing changes: the default path still uses Node's own `fetch`, and the regression script proves the requests are identical to before. If you do configure one, anything that can be checked without a network call is checked at startup.

The certificate lives in one small module and enters the request path at a single point, the choice of transport. The credential logic above it was not touched. That keeps the two gates independent, the way they are on the wire.

---

Source: [github.com/agenticDraft/aem-mcp-server](https://github.com/agenticDraft/aem-mcp-server) · forked from [easingthemes/aem-mcp-server](https://github.com/easingthemes/aem-mcp-server)
