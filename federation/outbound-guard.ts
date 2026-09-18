// The outbound guard: every request this node makes to a partner-supplied
// host goes through it. Spec: federation-protocol.md §Security Checklist
// ("treat all inbound … URLs as untrusted"), FP-2, FP-14.
//
// A partner's domain arrives from an administrator's form, from an
// unauthenticated X-OpenYacht-Node header, or from inside a listing payload.
// Without this guard any of them can point the server at its own loopback
// interface, a cloud metadata address or an internal service.
//
// There is deliberately no development escape hatch. A node that cannot be
// reached at a public address cannot federate, and a guard with a bypass is a
// guard that ships with the bypass on.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { isValidDomain } from "./identity";

export class BlockedOutboundHost extends Error {}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. Injected in tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));

// Everything that is not a globally routable unicast address.
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(address, "ipv4");
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) would smuggle any IPv4 range above past
  // the IPv6 rules, and no public host is legitimately published that way, so
  // it is refused outright. It cannot be a BlockList subnet: Node applies an
  // ::ffff:0:0/96 rule to plain IPv4 addresses too, which blocks all of IPv4.
  // The URL parser gives the canonical text form whichever way it was written.
  if (new URL(`http://[${address}]/`).hostname.startsWith("[::ffff:")) return false;
  return !blocked.check(address, "ipv6");
}

/**
 * Resolves `hostname` and returns its addresses, or throws. Every address must
 * be public: a name that resolves to one public and one private address is
 * refused, because which one a connection uses is not ours to choose.
 */
export async function resolvePublicHost(hostname: string, resolver: Resolver = systemResolver): Promise<ResolvedAddress[]> {
  const host = hostname.toLowerCase();
  // A bare DNS hostname: this alone rules out IP literals, ports, userinfo and paths.
  if (!isValidDomain(host)) throw new BlockedOutboundHost(`"${hostname}" is not a bare hostname.`);

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new BlockedOutboundHost(`${host} does not resolve.`);
  }
  if (addresses.length === 0) throw new BlockedOutboundHost(`${host} does not resolve.`);
  const refused = addresses.find(({ address }) => !isPublicAddress(address));
  if (refused) throw new BlockedOutboundHost(`${host} resolves to ${refused.address}, which is not a public address.`);
  return addresses;
}

/**
 * Validates a partner-supplied URL (a media URL, a callback): https only, no
 * credentials, no explicit port, and a hostname the guard accepts.
 */
export function parsePublicHttpsUrl(value: string): URL {
  if (!URL.canParse(value)) throw new BlockedOutboundHost("Not a URL.");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new BlockedOutboundHost("Only https:// URLs are allowed.");
  if (url.username !== "" || url.password !== "") throw new BlockedOutboundHost("URLs with credentials are not allowed.");
  if (url.port !== "") throw new BlockedOutboundHost("URLs with an explicit port are not allowed.");
  if (!isValidDomain(url.hostname)) throw new BlockedOutboundHost(`"${url.hostname}" is not a bare hostname.`);
  return url;
}
