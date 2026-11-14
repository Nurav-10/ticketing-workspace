import { isIP } from 'node:net';

export type ClientAddressPolicy =
  | { trustProxy: false }
  | { trustProxy: true; trustedProxyAddresses: readonly string[]; maxForwardedHops: number };

function expandIpv6(address: string): number[] | null {
  let input = address.toLowerCase();
  if (input.includes('.')) {
    const separator = input.lastIndexOf(':');
    const ipv4 = input.slice(separator + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = ((ipv4[0]! << 8) | ipv4[1]!).toString(16);
    const low = ((ipv4[2]! << 8) | ipv4[3]!).toString(16);
    input = `${input.slice(0, separator + 1)}${high}:${low}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array(halves.length === 2 ? missing : 0).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? groups
    : null;
}

function canonicalIpv6(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups) return null;
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  }

  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) { index++; continue; }
    let end = index;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.map((part) => part.toString(16)).join(':');
  const before = groups.slice(0, bestStart).map((part) => part.toString(16)).join(':');
  const after = groups.slice(bestStart + bestLength).map((part) => part.toString(16)).join(':');
  return `${before}::${after}`;
}

function normalizedIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) return canonicalIpv6(address);
  return null;
}

function validateProxyPolicy(policy: ClientAddressPolicy): ReadonlySet<string> {
  if (!policy.trustProxy) return new Set();
  if (!Array.isArray(policy.trustedProxyAddresses) || policy.trustedProxyAddresses.length === 0
    || !Number.isInteger(policy.maxForwardedHops) || policy.maxForwardedHops < 1 || policy.maxForwardedHops > 8) {
    throw new Error('Trusted proxy mode requires an explicit proxy IP allowlist and a hop limit from 1 to 8');
  }
  const addresses = policy.trustedProxyAddresses.map(normalizedIp);
  if (addresses.some((address) => address === null)) throw new Error('Trusted proxy allowlist contains an invalid IP address');
  return new Set(addresses as string[]);
}

/** Resolve an IP for HMAC bucketing without trusting arbitrary forwarded headers. */
export function resolveClientAddress(input: {
  socketRemoteAddress: unknown;
  forwardedFor: unknown;
  policy: ClientAddressPolicy;
}): string | null {
  const remote = normalizedIp(input.socketRemoteAddress);
  if (!remote) return null;
  if (!input.policy.trustProxy) return remote;

  const trustedProxies = validateProxyPolicy(input.policy);
  if (!trustedProxies.has(remote) || typeof input.forwardedFor !== 'string') return remote;
  if (input.forwardedFor.length > 1_024) return remote;
  const forwarded = input.forwardedFor.split(',').map(normalizedIp);
  if (forwarded.length === 0 || forwarded.length > input.policy.maxForwardedHops || forwarded.some((address) => address === null)) {
    return remote;
  }

  const chain = [...forwarded as string[], remote];
  let clientIndex = chain.length - 1;
  while (clientIndex > 0 && trustedProxies.has(chain[clientIndex]!)) clientIndex--;
  return chain[clientIndex]!;
}
