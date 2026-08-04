import { describe, expect, it, vi } from 'vitest';
import { resolveAmaranSecret } from '../src/secrets.js';

const options = {
  envName: 'AMARAN_OPENAPI_SECRET',
  keychainService: 'ORCHESTRA_AMARAN_OPENAPI',
  keychainAccount: 'orchestra',
};

describe('amaran secret resolution', () => {
  it('uses the environment only as an explicit development override', async () => {
    const keychain = vi.fn(async () => 'keychain-secret');
    await expect(
      resolveAmaranSecret(options, { AMARAN_OPENAPI_SECRET: 'environment-secret' }, keychain),
    ).resolves.toBe('environment-secret');
    expect(keychain).not.toHaveBeenCalled();
  });

  it('reads the live secret from Keychain when the environment is empty', async () => {
    const keychain = vi.fn(async () => 'keychain-secret');
    await expect(resolveAmaranSecret(options, {}, keychain)).resolves.toBe('keychain-secret');
    expect(keychain).toHaveBeenCalledWith('ORCHESTRA_AMARAN_OPENAPI', 'orchestra');
  });
});
