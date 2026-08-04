import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type KeychainReader = (service: string, account: string) => Promise<string | undefined>;

/** Read a generic password from the user's login Keychain without invoking a shell. */
export async function readKeychainSecret(
  service: string,
  account: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8', timeout: 2500 },
    );
    const secret = stdout.trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

/** Environment is a development fallback; Keychain is the normal live source. */
export async function resolveAmaranSecret(
  options: {
    envName: string;
    keychainService: string;
    keychainAccount: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  keychainReader: KeychainReader = readKeychainSecret,
): Promise<string | undefined> {
  const fromEnvironment = env[options.envName]?.trim();
  if (fromEnvironment) return fromEnvironment;
  return keychainReader(options.keychainService, options.keychainAccount);
}
