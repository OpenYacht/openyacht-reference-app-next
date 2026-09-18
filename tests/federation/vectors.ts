// The published request-signing test vectors, transcribed from
// protocol/spec/signing-test-vectors.md. `vectors.test.ts` asserts that every
// value here still appears verbatim in that vendored document.
//
// The keypair is published and therefore compromised by definition. It exists
// for tests only and must never be loaded into a running node.

export const TEST_KEY = {
  seedAscii: "OpenYacht-test-vector-seed-00001",
  seedHex: "4f70656e59616368742d746573742d766563746f722d736565642d3030303031",
  publicKey: "QKcwbi+S0spqvUIba9P45r2SDvKqbXmjCb6zsTn51Ac=",
  keyId: "25f0c5c537a07c58",
};

export const SENDER = "sender.example";
export const RECEIVER = "receiver.example";

export const VECTOR_1 = {
  method: "GET",
  pathAndQuery: "/openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50",
  timestamp: "2026-08-21T09:00:00Z",
  body: "",
  bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  signingString:
    "GET\n/openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50\nreceiver.example\n2026-08-21T09:00:00Z\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  signature: "0ZS5EQbB26H01ovHjBIJeYIp2hpK1rmB11zNr89HOKmbWsrTaAbfLXGrJ8kzigOBn8+3Z9ADf0g46/K9HInYAw==",
};

export const VECTOR_2 = {
  method: "POST",
  pathAndQuery: "/openyacht/v1/partners/request",
  timestamp: "2026-08-21T09:05:00Z",
  body: '{"message":"Requesting partnership for co-brokerage.","contact_email":"broker@sender.example"}',
  bodyLength: 94,
  bodySha256: "6702c6af06cc1732a1605c524713b79f39c2999595ddeb562c355824f85288ee",
  signingString:
    "POST\n/openyacht/v1/partners/request\nreceiver.example\n2026-08-21T09:05:00Z\n6702c6af06cc1732a1605c524713b79f39c2999595ddeb562c355824f85288ee",
  signature: "GdI9tqtzMIm3fzSArP8DHu1P2iKbcyOHQ9rST27sbeXXD7w9vPmeXBXmShjTwAxuJYrtuokrY7VGNvTzdGY8AA==",
};
