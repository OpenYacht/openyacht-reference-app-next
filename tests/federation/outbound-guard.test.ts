// The outbound guard. Spec: federation-protocol.md §Security Checklist.
import { describe, expect, it } from "vitest";
import { BlockedOutboundHost, isPublicAddress, parsePublicHttpsUrl, resolvePublicHost, type Resolver } from "@/federation";

const resolvesTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("FP-14 outbound guard: addresses", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd5c:1ff3::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "::ffff:93.184.216.34", // IPv4-mapped is refused even when the IPv4 address is public
    "0:0:0:0:0:ffff:7f00:1", // the same loopback, written out in full
    "2001:db8::1",
    "64:ff9b::a00:1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2a05:d018:5b7:f200::1", "2606:4700:4700::1111"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("refuses anything that is not an IP address", () => {
    expect(isPublicAddress("partner.example")).toBe(false);
  });
});

describe("FP-14 outbound guard: hostnames", () => {
  it("returns the addresses of a public host", async () => {
    await expect(resolvePublicHost("Partner.Example", resolvesTo("93.184.216.34"))).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it.each(["169.254.169.254", "127.0.0.1:6379", "[::1]", "localhost", "partner.example/path", "user@partner.example", "partner.example:8443", ""])(
    "refuses %s without resolving it",
    async (host) => {
      let resolved = false;
      const resolver: Resolver = async () => {
        resolved = true;
        return [{ address: "93.184.216.34", family: 4 }];
      };
      await expect(resolvePublicHost(host, resolver)).rejects.toBeInstanceOf(BlockedOutboundHost);
      expect(resolved).toBe(false);
    },
  );

  it("refuses a name that resolves to a private address", async () => {
    await expect(resolvePublicHost("internal.example", resolvesTo("10.0.0.5"))).rejects.toThrow(/not a public address/);
  });

  it("refuses a name that resolves to a public and a private address — which one is dialled is not ours to choose", async () => {
    await expect(resolvePublicHost("rebind.example", resolvesTo("93.184.216.34", "127.0.0.1"))).rejects.toBeInstanceOf(BlockedOutboundHost);
  });

  it("refuses a name that does not resolve", async () => {
    await expect(resolvePublicHost("gone.example", resolvesTo())).rejects.toThrow(/does not resolve/);
    await expect(
      resolvePublicHost("gone.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toBeInstanceOf(BlockedOutboundHost);
  });
});

describe("FP-2 / FP-14 outbound guard: partner-supplied URLs", () => {
  it("accepts a plain https URL", () => {
    expect(parsePublicHttpsUrl("https://media.partner.example/listings/1/profile.jpg").hostname).toBe("media.partner.example");
  });

  it.each([
    ["plain http", "http://partner.example/a.jpg"],
    ["credentials", "https://user:pw@partner.example/a.jpg"],
    ["an explicit port", "https://partner.example:8443/a.jpg"],
    ["an IP literal", "https://169.254.169.254/latest/meta-data"],
    ["a bare name", "https://localhost/a.jpg"],
    ["another scheme", "file:///etc/passwd"],
    ["not a URL", "not a url"],
  ])("refuses %s", (_label, url) => {
    expect(() => parsePublicHttpsUrl(url)).toThrow(BlockedOutboundHost);
  });
});
