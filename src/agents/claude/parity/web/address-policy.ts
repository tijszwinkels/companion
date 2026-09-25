/**
 * Which IP addresses `fetch_content` may connect to: public unicast only.
 *
 * Refused: loopback, private (RFC 1918, IPv6 unique-local), link-local,
 * carrier-grade NAT, multicast, reserved, documentation and benchmarking
 * ranges, unspecified addresses, and IPv6 forms that embed an IPv4 address
 * (IPv4-mapped, NAT64, 6to4, Teredo), whose embedded address could be any of
 * the above. The agent's web fetch therefore cannot reach services on this
 * machine or the local network, even through a redirect or a DNS name that
 * resolves to such an address (see `safe-fetch.ts`, which connects only to an
 * address this policy accepted).
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

const refusedIpv4 = new BlockList();
const refusedIpv4Ranges: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [network, prefix] of refusedIpv4Ranges) {
  refusedIpv4.addSubnet(network, prefix, 'ipv4');
}

const refusedIpv6 = new BlockList();
const refusedIpv6Ranges: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  // IPv4-compatible (deprecated) and IPv4-mapped addresses.
  ['::', 96],
  ['::ffff:0:0', 96],
  // NAT64, discard-only, Teredo, documentation, 6to4.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  // Unique-local, link-local, site-local (deprecated), multicast.
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [network, prefix] of refusedIpv6Ranges) {
  refusedIpv6.addSubnet(network, prefix, 'ipv6');
}

/** Decides whether a resolved address may be contacted. Tests may replace it. */
export type AddressPolicy = (address: string) => boolean;

/** The default policy: only public unicast IPv4 and IPv6 addresses. */
export const publicAddressesOnly: AddressPolicy = (address) => {
  if (isIPv4(address)) {
    return !refusedIpv4.check(address, 'ipv4');
  }

  if (isIPv6(address)) {
    // Zone IDs (fe80::1%eth0) only exist on link-local addresses.
    if (address.includes('%')) {
      return false;
    }
    return !refusedIpv6.check(address, 'ipv6');
  }

  return false;
};
