import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './user-agent.js';

describe('describeUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87', 'Edge on Windows'],
    ['Claude-User (claude-code/2.1.0; +https://support.anthropic.com/)', 'Claude'],
    ['Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0', 'Firefox on Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on Mac'],
  ])('%s → %s', (ua, label) => {
    expect(describeUserAgent(ua)).toBe(label);
  });
  it.each([null, undefined, '', 'curl/8.9.1'])('%s → Unknown device', (ua) => {
    expect(describeUserAgent(ua)).toBe('Unknown device');
  });
  it('stays fast on a 16 KB adversarial user agent', () => {
    // Many "Version/1" tokens and no "Safari/": the old `Version\/[\d.]+.*\bSafari\/` rule was quadratic on this.
    const hostile = 'Version/1 '.repeat(1640);
    expect(hostile.length).toBeGreaterThanOrEqual(16_384);
    const start = performance.now();
    expect(describeUserAgent(hostile)).toBe('Unknown device');
    expect(performance.now() - start).toBeLessThan(20);
  });
  it('only reads the first 512 characters', () => {
    expect(describeUserAgent(`${'x'.repeat(512)} Firefox/128.0 (X11; Linux x86_64)`)).toBe('Unknown device');
  });
});
