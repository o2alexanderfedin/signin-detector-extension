import { describe, expect, it } from 'vitest';

import { resolveWebAppKey } from './appIdentity';

describe('resolveWebAppKey', () => {
  it('resolves a subdomain URL to its eTLD+1', () => {
    expect(resolveWebAppKey('https://api.example.com/foo')).toBe('example.com');
  });

  it('resolves a www subdomain URL to its eTLD+1', () => {
    expect(resolveWebAppKey('https://www.example.com')).toBe('example.com');
  });

  it('collapses a different subdomain to the same key as api./www. (IDN-01)', () => {
    const apiKey = resolveWebAppKey('https://api.example.com/foo');
    const wwwKey = resolveWebAppKey('https://www.example.com');
    const cdnKey = resolveWebAppKey('https://cdn.example.com');

    expect(cdnKey).toBe('example.com');
    expect(cdnKey).toBe(apiKey);
    expect(cdnKey).toBe(wwwKey);
  });

  it('resolves a multi-part public suffix (eTLD+1) correctly', () => {
    expect(resolveWebAppKey('https://example.co.uk/path')).toBe('example.co.uk');
  });

  it('returns an identical WebAppKey value across SPA route/hash changes on the same host (IDN-02)', () => {
    const routeA = resolveWebAppKey('https://example.com/app#/route/a');
    const routeB = resolveWebAppKey('https://example.com/app#/route/b');

    expect(routeA).not.toBeNull();
    expect(routeA).toBe(routeB);
  });

  it('returns null for localhost', () => {
    expect(resolveWebAppKey('http://localhost:3000')).toBeNull();
  });

  it('returns null for a bare IP-address host', () => {
    expect(resolveWebAppKey('http://192.168.1.1')).toBeNull();
  });

  it('returns null for an IP-address host with a port and path', () => {
    expect(resolveWebAppKey('http://192.168.1.1:8080/path')).toBeNull();
  });

  it('returns null for a chrome:// URL', () => {
    expect(resolveWebAppKey('chrome://extensions')).toBeNull();
  });

  it('returns null for a file:// URL', () => {
    expect(resolveWebAppKey('file:///Users/x/file.html')).toBeNull();
  });

  it('returns null for an about: URL', () => {
    expect(resolveWebAppKey('about:blank')).toBeNull();
  });
});
