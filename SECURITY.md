# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's advisory form — the
**Report a vulnerability** button under this repository's _Security_ tab. Do
not open a public issue for a suspected vulnerability.

Include what you found, how to reproduce it, and which part it concerns. The
federation layer (`federation/`, `lib/federation/`, the routes under
`app/.well-known/` and `app/openyacht/`) is the most security-sensitive code
here, and reports about it are especially welcome.

If the problem is in the protocol itself rather than in this implementation —
the signing scheme, the trust model, a schema — report it to the protocol
repository instead: <https://github.com/OpenYacht/protocol>.

## What is deliberately not a vulnerability

- **The well-known document, `capabilities` and `health` are public and
  unsigned.** The protocol requires it. They publish the node's name, UUID,
  public keys and endpoint paths, and nothing else.
- **The node UUID is public.** It is not a trust anchor; it exists so partners
  can detect that a domain now hosts a different installation.
- **Federation endpoints answer `404` on every host except the identity
  domain.** That is the single-host guard, not a misconfiguration.
- **The signing test vectors' private key is in this repository**
  (`tests/federation/vectors.ts`). It is published by the protocol, compromised
  by definition, and used only by tests. It is never loaded by a running node.

## Supported versions

This is a reference implementation under active development. Only the latest
commit on `main` is supported.
