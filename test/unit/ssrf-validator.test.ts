import { describe, it, expect } from 'vitest';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import { CliOperationError } from '../../src/domain/errors.js';

describe('SsrfValidator Unit Tests (Gate T-02)', () => {
  it('identifies private, loopback, link-local, and restricted IPv4 addresses', () => {
    // Loopback
    expect(SsrfValidator.isPrivateIpv4('127.0.0.1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('127.255.255.254')).toBe(true);

    // Private RFC 1918
    expect(SsrfValidator.isPrivateIpv4('10.0.0.1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('10.255.0.1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('172.31.255.255')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('192.168.1.1')).toBe(true);

    // Link-local / AWS metadata
    expect(SsrfValidator.isPrivateIpv4('169.254.169.254')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('0.0.0.0')).toBe(true);
    expect(SsrfValidator.isPrivateIpv4('255.255.255.255')).toBe(true);

    // Public IPv4 (allowed)
    expect(SsrfValidator.isPrivateIpv4('93.184.216.34')).toBe(false);
    expect(SsrfValidator.isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(SsrfValidator.isPrivateIpv4('1.1.1.1')).toBe(false);
  });

  it('identifies private, loopback, link-local, and unique-local IPv6 addresses', () => {
    expect(SsrfValidator.isPrivateIpv6('::1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv6('::')).toBe(true);
    expect(SsrfValidator.isPrivateIpv6('fe80::1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv6('fc00::1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv6('fd12:3456:789a:1::1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(SsrfValidator.isPrivateIpv6('::ffff:192.168.1.100')).toBe(true);

    // Public IPv6 (allowed)
    expect(SsrfValidator.isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
    expect(SsrfValidator.isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
  });

  it('blocks direct private IP in URL hostname', async () => {
    const validator = new SsrfValidator();

    await expect(validator.validate('https://127.0.0.1/admin')).rejects.toThrowError(
      CliOperationError,
    );

    await expect(validator.validate('http://169.254.169.254/latest/meta-data', { allowHttp: true })).rejects.toThrowError(
      CliOperationError,
    );

    await expect(validator.validate('https://192.168.1.1/secret')).rejects.toThrowError(
      CliOperationError,
    );
  });

  it('blocks hostnames that resolve to private IPs via mockable DNS seam', async () => {
    const mockLookup = async (host: string): Promise<string[]> => {
      if (host === 'evil-internal.com') {
        return ['10.0.0.5'];
      }
      if (host === 'evil-loopback.com') {
        return ['127.0.0.1'];
      }
      if (host === 'evil-v6.com') {
        return ['fe80::2'];
      }
      if (host === 'valid-public.com') {
        return ['93.184.216.34'];
      }
      return [];
    };

    const validator = new SsrfValidator(mockLookup);

    // Blocked DNS resolutions
    await expect(validator.validate('https://evil-internal.com/docs')).rejects.toThrowError(
      CliOperationError,
    );
    await expect(validator.validate('https://evil-loopback.com/docs')).rejects.toThrowError(
      CliOperationError,
    );
    await expect(validator.validate('https://evil-v6.com/docs')).rejects.toThrowError(
      CliOperationError,
    );

    // Allowed DNS resolution
    await expect(validator.validate('https://valid-public.com/docs')).resolves.toBeUndefined();
  });

  it('enforces HTTPS protocol by default and rejects HTTP unless allowHttp: true', async () => {
    const mockLookup = async () => ['93.184.216.34'];
    const validator = new SsrfValidator(mockLookup);

    await expect(validator.validate('http://valid-public.com/docs')).rejects.toThrowError(
      CliOperationError,
    );

    await expect(
      validator.validate('http://valid-public.com/docs', { allowHttp: true }),
    ).resolves.toBeUndefined();
  });

  it('rejects disallowed protocols and non-standard ports', async () => {
    const mockLookup = async () => ['93.184.216.34'];
    const validator = new SsrfValidator(mockLookup);

    await expect(validator.validate('ftp://valid-public.com/file')).rejects.toThrowError(
      CliOperationError,
    );

    await expect(validator.validate('https://valid-public.com:8443/docs')).rejects.toThrowError(
      CliOperationError,
    );
  });

  it('validates allowedHosts whitelist', async () => {
    const mockLookup = async () => ['93.184.216.34'];
    const validator = new SsrfValidator(mockLookup);

    await expect(
      validator.validate('https://valid-public.com/docs', { allowedHosts: ['palantir.com'] }),
    ).rejects.toThrowError(CliOperationError);

    await expect(
      validator.validate('https://valid-public.com/docs', { allowedHosts: ['valid-public.com'] }),
    ).resolves.toBeUndefined();
  });
});
