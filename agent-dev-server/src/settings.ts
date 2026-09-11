import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseEnv } from 'node:util';

type SecretsConfiguration = {};

class Settings {
  /**
   * Default values for env variables
   */
  configuration: SecretsConfiguration = {} as SecretsConfiguration;

  getSecret(key) {
    return this.configuration[key] || process.env[key];
  }

  getBooleanSecret(key) {
    return this.configuration[key] === 'true' || this.configuration[key] === 1;
  }

  isLocal() {
    return !process.env.ENV || process.env.ENV === 'local';
  }

  isProd() {
    return process.env.ENV === 'production';
  }

  getAppName() {
    if (this.isLocal()) {
      return 'agent-local';
    }
    return 'agent-prod';
  }

  async load() {
    if (this.isLocal()) {
      try {
        loadEnvFile();
      } catch {
        console.warn('No env file loaded');
      } // that ok
    }
    // Load `.env.runtime` once at boot. Tokens written by the Settings
    // panel and the file editor both restart the dev-server (control-server's
    // `modify-file` route triggers an esbuild rebuild, which SIGKILLs and
    // respawns the process). So a single boot-time load is sufficient — no
    // per-request reload needed.
    try {
      const envPath = join(process.cwd(), '.env.runtime');
      const content = readFileSync(envPath, 'utf-8');
      Object.assign(process.env, parseEnv(content) as Record<string, string>);
    } catch {
      // missing or unreadable — fine
    }
    Object.assign(this.configuration, process.env);
  }
}

export default Settings;
