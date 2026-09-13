/**
 * SsrfValidator
 * Validates URLs against SSRF threats: private/loopback/link-local IP addresses,
 * protocol constraints, and allowed hosts.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import * as dns from 'node:dns/promises';
import { CliOperationError } from '../../domain/errors.js';

export type DnsLookupFn = (hostname: string) => Promise<string[]>;

export interface SsrfValidationOptions {
  allowedHosts?: string[];
  allowHttp?: boolean;
}

export class SsrfValidator {
  private readonly dnsLookup: DnsLookupFn;

  constructor(dnsLookup?: DnsLookupFn) {
    this.dnsLookup = dnsLookup ?? this.defaultDnsLookup;
  }

  private async defaultDnsLookup(hostname: string): Promise<string[]> {
    try {
      const results = await dns.lookup(hostname, { all: true });
      return results.map((r) => r.address);
    } catch (err) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `DNS resolution failed for host '${hostname}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Checks if an IPv4 address is private, loopback, link-local, or restricted.
   */
  static isPrivateIpv4(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true; // invalid IPv4 -> reject
    }
    const [b0, b1] = parts;
    if (b0 === undefined || b1 === undefined) return true;

    // 0.0.0.0/8 (current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (private)
    if (b0 === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (link-local & cloud metadata 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (private)
    if (b0 === 192 && b1 === 168) return true;
    // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved) and 255.255.255.255
    if (b0 >= 224) return true;

    return false;
  }

  /**
   * Checks if an IPv6 address is private, loopback, link-local, or unique-local.
   */
  static isPrivateIpv6(ip: string): boolean {
    const clean = ip.toLowerCase().trim();

    // Loopback or unspecified
    if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1' || clean === '0:0:0:0:0:0:0:0') {
      return true;
    }

    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (clean.includes('::ffff:') || clean.startsWith('0:0:0:0:0:ffff:')) {
      const lastColon = clean.lastIndexOf(':');
      const tail = clean.slice(lastColon + 1);
      if (tail.includes('.')) {
        return this.isPrivateIpv4(tail);
      }
      // Hex representation in mapped IPv6
      return true;
    }

    // Link-local: fe80::/10 (fe80 - febf)
    if (/^[fF][eE][89abAB]/.test(clean)) {
      return true;
    }

    // Unique Local: fc00::/7 (fc00 - fdff)
    if (/^[fF][cdCD]/.test(clean)) {
      return true;
    }

    return false;
  }

  /**
   * Determines if an IP (v4 or v6) is private or restricted.
   */
  static isPrivateOrRestrictedIp(ip: string): boolean {
    if (ip.includes(':')) {
      return this.isPrivateIpv6(ip);
    }
    return this.isPrivateIpv4(ip);
  }

  /**
   * Validates a URL against SSRF and security constraints:
   * 1. Protocol is HTTPS (or HTTP if allowHttp is explicitly true)
   * 2. Host is in allowedHosts (if provided)
   * 3. Hostname does not directly specify a private/loopback/link-local IP
   * 4. DNS resolution of hostname does not yield private/loopback/link-local IP
   */
  async validate(urlStr: string, options: SsrfValidationOptions = {}): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `Invalid URL '${urlStr}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 1. Protocol check
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `Disallowed protocol '${parsed.protocol}' for URL '${urlStr}'. Only HTTP/HTTPS allowed.`,
      });
    }

    if (parsed.protocol === 'http:' && !options.allowHttp) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `HTTP protocol is blocked for URL '${urlStr}'. Set allowHttp: true in library config to allow.`,
      });
    }

    // 2. Port check
    if (parsed.port !== '') {
      const portNum = Number(parsed.port);
      if (
        (parsed.protocol === 'http:' && portNum !== 80) ||
        (parsed.protocol === 'https:' && portNum !== 443)
      ) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: `Non-standard port '${parsed.port}' is blocked for URL '${urlStr}'.`,
        });
      }
    }

    // 3. Allowed hosts check
    const hostname = parsed.hostname.toLowerCase();
    if (options.allowedHosts && options.allowedHosts.length > 0) {
      const isAllowed = options.allowedHosts.some((h) => h.toLowerCase() === hostname);
      if (!isAllowed) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: `Host '${hostname}' is not in allowedHosts: [${options.allowedHosts.join(', ')}]`,
        });
      }
    }

    // 4. Literal IP check (strip brackets for IPv6)
    const rawHost = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

    const isIpv4Literal = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawHost);
    const isIpv6Literal = rawHost.includes(':');

    if ((isIpv4Literal || isIpv6Literal) && SsrfValidator.isPrivateOrRestrictedIp(rawHost)) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `SSRF blocked: Host '${hostname}' is a private, loopback, or link-local IP address.`,
      });
    }

    // 5. DNS Resolution check (mockable seam)
    const ips = await this.dnsLookup(rawHost);
    if (!ips || ips.length === 0) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `DNS resolution returned zero IP addresses for host '${hostname}'.`,
      });
    }

    for (const ip of ips) {
      if (SsrfValidator.isPrivateOrRestrictedIp(ip)) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: `SSRF blocked: Host '${hostname}' resolves to restricted IP '${ip}'.`,
        });
      }
    }
  }
}
