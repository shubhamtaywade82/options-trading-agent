import { DhanClient, TokenManager } from '@nemesis-oss/dhanhq-sdk';
import type { AgentConfig, SandboxConfig } from '../config.js';
import type { Logger } from '../ops/logger.js';
import { assertUsableToken, createTotpProvider, formatExpiry, singleFlight } from './auth.js';

export interface DhanClientOptions {
  readonly logger?: Logger;
  readonly now?: () => number;
  /**
   * Present in sandbox mode. The SDK's `hybrid` mode then serves market data from production on the production
   * credentials, and sends orders, positions, funds and controls to the sandbox on these credentials.
   */
  readonly sandbox?: SandboxConfig;
}

/** The SDK options that switch a client to sandbox orders. Empty for live and paper, which send orders only to production or nowhere. */
function sandboxOptions(sandbox: SandboxConfig | undefined): {
  mode?: 'hybrid';
  sandboxToken?: string;
  sandboxClientId?: string;
  sandboxBaseURL?: string;
} {
  if (sandbox === undefined) {
    return {};
  }
  return {
    mode: 'hybrid',
    sandboxToken: sandbox.accessToken,
    sandboxClientId: sandbox.clientId,
    ...(sandbox.baseUrl === undefined ? {} : { sandboxBaseURL: sandbox.baseUrl }),
  };
}

/**
 * Builds the SDK client. Credentials come only from validated config.
 *
 * Static-token mode returns a plain client. OTP mode (PIN + TOTP) logs in before
 * returning, so a wrong PIN or secret stops startup instead of the first market-data
 * call. Renewal is automatic: each request asks the token manager for a valid token,
 * which renews shortly before expiry.
 *
 * The OTP token provider is set in the constructor, not installed afterwards, because
 * the SDK copies `tokenProvider` into its WebSocket clients when the client is built.
 * A provider added later would leave the market-data and order-update feeds without a token.
 *
 * The SDK's own retry policy already guarantees that trading writes are sent at most
 * once, so no retry wrapper is layered on top of order placement.
 */
export async function createDhanClient(dhan: AgentConfig['dhan'], options: DhanClientOptions = {}): Promise<DhanClient> {
  const baseURL = dhan.baseUrl === undefined ? {} : { baseURL: dhan.baseUrl };
  const sandbox = sandboxOptions(options.sandbox);
  if (dhan.auth.kind === 'static') {
    return new DhanClient({ clientId: dhan.clientId, token: dhan.auth.accessToken, ...baseURL, ...sandbox });
  }

  const { pin, totpSecret } = dhan.auth;
  const now = options.now ?? Date.now;
  let manager: TokenManager | undefined;
  const current = (): TokenManager => {
    if (manager === undefined) {
      throw new Error('Dhan token manager used before it was attached to the client');
    }
    return manager;
  };
  // Several requests can see 401 at once. They must share one renewal, not start one each.
  const renew = singleFlight(() => current().refresh());

  let renewalDegraded = false;
  const provide = async (): Promise<string> => {
    const attached = current();
    try {
      const token = await attached.ensureValidToken();
      renewalDegraded = false;
      return token;
    } catch (error) {
      // A renewal that fails on the network does not invalidate the token already held.
      // Keep using it until it expires, rather than failing every request in the renewal window.
      const held = attached.getToken();
      if (held?.expiresAt === undefined || now() >= held.expiresAt) {
        throw error;
      }
      if (!renewalDegraded) {
        renewalDegraded = true;
        options.logger?.warn('dhan token renewal failed; using the current token until it expires', {
          expiresAt: formatExpiry(held.expiresAt),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return held.accessToken;
    }
  };

  const client = new DhanClient({
    clientId: dhan.clientId,
    tokenProvider: provide,
    onTokenExpired: async () => {
      await renew();
    },
    ...baseURL,
    ...sandbox,
  });
  // Built directly, not through client.auth.enableAutoTokenManagement, because that call replaces
  // the provider in the client config. REST and both WebSocket feeds must share `provide`.
  manager = new TokenManager(client.getConfig(), {
    clientId: dhan.clientId,
    pin,
    totpProvider: createTotpProvider(totpSecret, { now }),
    onToken: (token) => {
      // Logs the expiry only. The token, PIN and TOTP secret never reach a log line.
      options.logger?.info('dhan access token issued', { expiresAt: formatExpiry(token.expiresAt) });
    },
  });

  await current().ensureValidToken();
  assertUsableToken(current().getToken(), now());
  return client;
}
