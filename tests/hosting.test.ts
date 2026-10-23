/** Where MWA runs, for the settings page's wording (src/hosting.ts). */
import { describe, it, expect } from 'vitest';
import { isHosted, hostName } from '../src/hosting.js';

describe('where MWA runs', () => {
  const no = () => false;
  it('Railway, Azure Container Apps, Cloud Run and Docker are servers; a plain computer is not', () => {
    expect(isHosted({ RAILWAY_ENVIRONMENT_NAME: 'production' }, no)).toBe(true);
    expect(isHosted({ CONTAINER_APP_NAME: 'mwa' }, no)).toBe(true);
    expect(isHosted({ K_SERVICE: 'mwa' }, no)).toBe(true);
    expect(isHosted({}, () => true)).toBe(true);
    expect(isHosted({}, no)).toBe(false);
  });
  it('MWA_HOSTED overrides either way', () => {
    expect(isHosted({ MWA_HOSTED: '1' }, no)).toBe(true);
    expect(isHosted({ MWA_HOSTED: 'off', RAILWAY_PROJECT_ID: 'x' }, () => true)).toBe(false);
  });
  it('names the host', () => {
    expect(hostName({ RAILWAY_PROJECT_ID: 'x' })).toBe('Railway');
    expect(hostName({})).toBe('your server');
  });
});
