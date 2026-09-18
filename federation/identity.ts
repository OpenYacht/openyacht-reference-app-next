// This node's configured identity. Spec: federation-protocol.md §Choosing the
// identity domain.
//
// The rule this file exists for: a blank identity value fails loudly. A
// variable that is present but empty reads as "" in every environment loader,
// and "" is a valid `node.name` under well-known.schema.json — so without this
// check a half-configured node publishes a nameless identity to its partners
// and nothing anywhere reports an error. The schema cannot catch it:
// `node.name` has no `minLength`. Likewise a node with no website publishes
// `null`, never "".

export interface NodeIdentity {
  /** Lowercase hostname. Permanent: it is part of every canonical listing URI. */
  domain: string;
  name: string;
  website: string | null;
}

export class IdentityConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Node identity is misconfigured:\n- ${problems.join("\n- ")}`);
  }
}

// A DNS hostname: dot-separated labels, no scheme, port, path or userinfo.
// At least two labels, and the last one alphabetic, which also rules out IP
// literals.
const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidDomain(value: string): boolean {
  return HOSTNAME_PATTERN.test(value);
}

export function parseNodeIdentity(env: Record<string, string | undefined>): NodeIdentity {
  const problems: string[] = [];

  const domain = (env.OPENYACHT_DOMAIN ?? "").trim().toLowerCase();
  if (domain === "") problems.push("OPENYACHT_DOMAIN is not set. It is the node's permanent identity domain.");
  else if (!isValidDomain(domain)) {
    problems.push(`OPENYACHT_DOMAIN "${domain}" is not a bare hostname (no scheme, port or path).`);
  }

  const name = (env.OPENYACHT_NODE_NAME ?? "").trim();
  if (name === "") problems.push("OPENYACHT_NODE_NAME is not set. Partners see this name when deciding whether to approve the node.");

  // Optional: unset or blank both mean "no website", published as null.
  let website: string | null = (env.OPENYACHT_WEBSITE ?? "").trim() || null;
  if (website !== null) {
    const parsed = URL.canParse(website) ? new URL(website) : null;
    if (parsed === null || parsed.protocol !== "https:") {
      problems.push(`OPENYACHT_WEBSITE "${website}" is not an https:// URL.`);
      website = null;
    }
  }

  if (problems.length > 0) throw new IdentityConfigError(problems);
  return { domain, name, website };
}

/**
 * Single-host guard: federation endpoints answer only on the identity domain,
 * so a node reachable under several hostnames cannot fork its identity.
 * `hostHeader` is the request's Host value, which may carry a port.
 */
export function isIdentityHost(hostHeader: string | null, identityDomain: string): boolean {
  if (hostHeader === null) return false;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  return host === identityDomain;
}
