import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { PAGE_FIXTURES, testPageCtx } from './fixtures.js';

describe('Profile password form', () => {
  it('names the account for password managers with a hidden username field before the passwords', () => {
    const doc = new JSDOM(PAGE_FIXTURES['profilePage:local']!(testPageCtx())).window.document;
    const form = doc.querySelector('form[action="/admin/profile/password"]')!;
    const user = form.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(user.value).toBe('asa.oberg-angstrom@example.com');
    expect(user.hidden).toBe(true);
    expect(user.readOnly).toBe(true);
    const inputs = [...form.querySelectorAll('input:not([type=hidden])')];
    expect(inputs.indexOf(user)).toBeLessThan(inputs.findIndex((i) => i.getAttribute('autocomplete') === 'current-password'));
  });
});
