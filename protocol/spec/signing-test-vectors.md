# Request-Signing Test Vectors

**Status**: Draft v0.1 (2026-08) — companion to `federation-protocol.md` §Request Signing. An implementation whose signing code reproduces these signatures byte-for-byte, and whose verification code accepts them, interoperates with every other conforming implementation.

⚠ **The keypair below is published and therefore compromised by definition. It exists only for tests. Never load it into a running node.**

## Test keypair

| Item | Value |
|---|---|
| Private key (raw 32-byte seed, hex) | `4f70656e59616368742d746573742d766563746f722d736565642d3030303031` |
| — same seed as ASCII (32 bytes) | `OpenYacht-test-vector-seed-00001` |
| Public key (base64, raw 32 bytes) | `QKcwbi+S0spqvUIba9P45r2SDvKqbXmjCb6zsTn51Ac=` |
| Key ID (first 16 hex chars of SHA-256 of raw public key) | `25f0c5c537a07c58` |

Deriving the key ID is itself a useful first test: `sha256(raw_public_key_bytes)` → hex → first 16 characters.

## Signing-string construction (normative reference)

Per `federation-protocol.md`: the UTF-8 concatenation, joined by single `\n` (0x0A) characters — no trailing newline — of:

1. uppercase HTTP method
2. request path **including query string**
3. lowercase host of the receiving node
4. the `X-OpenYacht-Timestamp` value
5. lowercase hex SHA-256 of the raw request body (the hash of the empty string for bodyless requests)

The Ed25519 signature is computed over the UTF-8 bytes of that string and sent base64-encoded in `X-OpenYacht-Signature`.

## Vector 1 — bodyless GET

Request:

```
GET /openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50 HTTP/1.1
Host: receiver.example
X-OpenYacht-Node: sender.example
X-OpenYacht-Key: 25f0c5c537a07c58
X-OpenYacht-Timestamp: 2026-08-21T09:00:00Z
```

Body SHA-256 (empty body — this is the well-known SHA-256 of the empty string):

```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Signing string (`\n` rendered visibly; there are exactly four newlines):

```
GET\n/openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50\nreceiver.example\n2026-08-21T09:00:00Z\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Expected `X-OpenYacht-Signature`:

```
0ZS5EQbB26H01ovHjBIJeYIp2hpK1rmB11zNr89HOKmbWsrTaAbfLXGrJ8kzigOBn8+3Z9ADf0g46/K9HInYAw==
```

## Vector 2 — POST with JSON body

Request:

```
POST /openyacht/v1/partners/request HTTP/1.1
Host: receiver.example
Content-Type: application/json
X-OpenYacht-Node: sender.example
X-OpenYacht-Key: 25f0c5c537a07c58
X-OpenYacht-Timestamp: 2026-08-21T09:05:00Z
```

Body — the raw bytes hashed are exactly this 94-byte string, no trailing newline:

```
{"message":"Requesting partnership for co-brokerage.","contact_email":"broker@sender.example"}
```

Body SHA-256:

```
6702c6af06cc1732a1605c524713b79f39c2999595ddeb562c355824f85288ee
```

Signing string:

```
POST\n/openyacht/v1/partners/request\nreceiver.example\n2026-08-21T09:05:00Z\n6702c6af06cc1732a1605c524713b79f39c2999595ddeb562c355824f85288ee
```

Expected `X-OpenYacht-Signature`:

```
GdI9tqtzMIm3fzSArP8DHu1P2iKbcyOHQ9rST27sbeXXD7w9vPmeXBXmShjTwAxuJYrtuokrY7VGNvTzdGY8AA==
```

## Negative tests every verifier should pass

Using vector 1 as the base, verification MUST fail when:

1. Any single byte of the signing string changes (e.g. `page_size=51`) — signature invalid.
2. The timestamp in the header differs from the one in the signing string — signature invalid.
3. The timestamp is valid and signed but outside ±300 s of the receiver's clock — reject with `TIMESTAMP_OUT_OF_RANGE` *without* a signature check being the deciding factor.
4. The body is altered after signing (POST vector with an extra space in the JSON) — body-hash mismatch → signature invalid.
5. `X-OpenYacht-Key` names a key ID the sender's well-known document does not list — after the one permitted fresh refetch, reject with `SIGNATURE_INVALID`.

## Reproducing these vectors

Python (`cryptography` package):

```python
import base64, hashlib
from cryptography.hazmat.primitives.asymmetric import ed25519

priv = ed25519.Ed25519PrivateKey.from_private_bytes(b"OpenYacht-test-vector-seed-00001")
signing_string = "\n".join([
    "GET",
    "/openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50",
    "receiver.example",
    "2026-08-21T09:00:00Z",
    hashlib.sha256(b"").hexdigest(),
])
print(base64.b64encode(priv.sign(signing_string.encode())).decode())
```

PHP (`sodium`, as the Laravel reference implementation would use):

```php
$seed = 'OpenYacht-test-vector-seed-00001';
$keypair = sodium_crypto_sign_seed_keypair($seed);
$secret  = sodium_crypto_sign_secretkey($keypair);
$signingString = implode("\n", [
    'GET',
    '/openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50',
    'receiver.example',
    '2026-08-21T09:00:00Z',
    hash('sha256', ''),
]);
echo base64_encode(sodium_crypto_sign_detached($signingString, $secret));
```
