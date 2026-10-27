// v2 build, slice P3: this device's notification state in plain words (web/src/pwa/push.ts) and where a tapped
// notification lands in the app (web/src/v2/shell/notifyRoute.ts).
import { describe, it, expect } from 'vitest';
import { pushState, pushWords, unblockSteps, platformName, type PushFacts } from '../web/src/pwa/push';
import { parseNotifyHash, hashOfOpenUrl, placeOf } from '../web/src/v2/shell/notifyRoute';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const base: PushFacts = { secure: true, hasWorker: true, hasPush: true, hasNotification: true, permission: 'default', userAgent: ANDROID, standalone: false, subscribed: false };

describe('this device\'s notification state', () => {
  it('on, off, blocked, iPhone needs install, insecure address, unsupported', () => {
    expect(pushState(base)).toBe('off');
    expect(pushState({ ...base, permission: 'granted', subscribed: true })).toBe('on');
    expect(pushState({ ...base, permission: 'granted', subscribed: false })).toBe('off'); // allowed, but the server doesn't know it
    expect(pushState({ ...base, permission: 'denied' })).toBe('blocked');
    expect(pushState({ ...base, userAgent: IPHONE, hasPush: false })).toBe('ios-install');
    expect(pushState({ ...base, userAgent: IPHONE, standalone: true })).toBe('off');
    expect(pushState({ ...base, secure: false })).toBe('insecure');
    expect(pushState({ ...base, hasPush: false })).toBe('unsupported');
  });
  it('plain words, with how to unblock for this browser, and the secure address', () => {
    expect(pushWords('off', base, 'https://mwa.tail.ts.net').button).toBe('Turn on notifications');
    expect(pushWords('on', base, '').button).toBe('Turn off');
    expect(pushWords('blocked', base, '').line).toMatch(/Permissions › Notifications › Allow/);
    expect(pushWords('blocked', { ...base, standalone: true }, '').line).toMatch(/App info › Notifications/);
    expect(unblockSteps(IPHONE, true)).toMatch(/Settings › Notifications › MWA/);
    expect(pushWords('ios-install', { ...base, userAgent: IPHONE }, '').line).toMatch(/Add to Home Screen/);
    expect(pushWords('insecure', base, 'https://mwa.tail.ts.net').line).toContain('https://mwa.tail.ts.net');
    expect(platformName(ANDROID)).toBe('android');
    expect(platformName(IPHONE)).toBe('ios');
  });
});

describe('where a tapped notification lands', () => {
  it('parses the places, refusing odd ids', () => {
    expect(parseNotifyHash('#/today')).toEqual({ to: 'today' });
    expect(parseNotifyHash('#/approval/ap_1')).toEqual({ to: 'approval', id: 'ap_1' });
    // S4: "Something needs your OK" opens that approval in the approval sheet (decided there), not just Today
    expect(placeOf({ to: 'approval', id: 'ap_1' })).toEqual({ view: 'today', sheet: 'approval', id: 'ap_1' });
    expect(placeOf({ to: 'job', id: 'j_abc' })).toEqual({ view: 'today', sheet: 'work', id: 'j_abc' });
    expect(placeOf({ to: 'settings' })).toEqual({ view: 'settings', sheet: null, id: null });
    expect(parseNotifyHash('#/job/j_abc')).toEqual({ to: 'job', id: 'j_abc' });
    expect(parseNotifyHash('#/job/%3Cscript%3E')).toEqual({ to: 'work' });
    expect(parseNotifyHash('#/work')).toEqual({ to: 'work' });
    expect(parseNotifyHash('#/settings/notifications')).toEqual({ to: 'settings' });
    expect(parseNotifyHash('#rules')).toBeNull();
    expect(parseNotifyHash('')).toBeNull();
    expect(parseNotifyHash('#/elsewhere')).toBeNull();
  });
  it('a URL from the worker counts only at this origin', () => {
    expect(hashOfOpenUrl('https://mwa.tail.ts.net/?ui=v2#/job/j1', 'https://mwa.tail.ts.net')).toBe('#/job/j1');
    expect(hashOfOpenUrl('https://evil.example/#/job/j1', 'https://mwa.tail.ts.net')).toBeNull();
    expect(hashOfOpenUrl(42, 'https://mwa.tail.ts.net')).toBeNull();
  });
});
