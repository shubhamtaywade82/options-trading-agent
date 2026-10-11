import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AuthenticationError, DhanAuth, TokenResponse } from '@nemesis-oss/dhanhq-sdk';
import {
  assertUsableToken,
  clarifyDhanLoginFailure,
  createTotpProvider,
  formatExpiry,
  loginErrorFromBody,
  singleFlight,
  TOTP_MIN_VALID_SECONDS,
} from '../src/dhan/auth.js';
import { createDhanClient } from '../src/dhan/client.js';
import type { Logger } from '../src/ops/logger.js';

/** RFC 4648 base32 of an ASCII seed, without padding. */
function base32(seed: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...Buffer.from(seed, 'ascii')].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  let encoded = '';
  for (let index = 0; index < bits.length; index += 5) {
    encoded += alphabet.charAt(Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2));
  }
  return encoded;
}
/** RFC 6238 SHA-1 test secret: the seed "12345678901234567890", in base32. Computed, so the file holds no secret-shaped literal. */
const RFC_SECRET = base32('12345678901234567890');
/** RFC 6238 vector for T=59 s (8-digit 94287082), truncated to the 6 digits Dhan uses. */
const RFC_CODE_WINDOW_1 = '287082';

describe('createTotpProvider', () => {
  it('matches the RFC 6238 vector for the current window and does not wait when enough time remains', async () => {
    let sleeps = 0;
    const provider = createTotpProvider(RFC_SECRET, {
      now: () => 45_000,
      sleep: async () => {
        sleeps += 1;
      },
    });
    assert.equal(await provider(), RFC_CODE_WINDOW_1);
    assert.equal(sleeps, 0);
  });

  it('waits for the next window instead of sending a code that could expire in transit', async () => {
    let clock = 28_000;
    const waits: number[] = [];
    const provider = createTotpProvider(RFC_SECRET, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const code = await provider();
    // 2 s left in window 0; the wait lands 1 s into window 1, so the code is window 1's.
    assert.deepEqual(waits, [3_000]);
    assert.equal(code, RFC_CODE_WINDOW_1);
  });

  it('does not wait when exactly the minimum margin remains', async () => {
    const waits: number[] = [];
    // At 25 s, 5 s remain in the window, which equals the margin and is not below it.
    const provider = createTotpProvider(RFC_SECRET, {
      now: () => 25_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await provider();
    assert.equal(TOTP_MIN_VALID_SECONDS, 5);
    assert.deepEqual(waits, []);
  });
});

describe('loginErrorFromBody', () => {
  it('returns undefined when the body carries an access token', () => {
    assert.equal(loginErrorFromBody({ accessToken: 'abc' }), undefined);
    assert.equal(loginErrorFromBody({ access_token: 'abc' }), undefined);
  });

  it('surfaces broker error messages when HTTP succeeded but no token was issued', () => {
    assert.equal(loginErrorFromBody({ status: 'error', message: 'Invalid TOTP' }), 'Dhan login failed: Invalid TOTP');
  });

  it('reports a non-success status when there is no token and no message field', () => {
    assert.equal(loginErrorFromBody({ status: 'error' }), 'Dhan login failed (status=error)');
  });
});

describe('clarifyDhanLoginFailure', () => {
  it('replaces the SDK generic message with a probed broker detail', async () => {
    const error = await clarifyDhanLoginFailure(new Error('Token response did not contain an accessToken'), async () =>
      'Dhan login failed: Invalid TOTP',
    );
    assert.equal(error.message, 'Dhan login failed: Invalid TOTP');
    assert.equal((error.cause as Error | undefined)?.message, 'Token response did not contain an accessToken');
  });

  it('passes through AuthenticationError from the SDK', async () => {
    const error = await clarifyDhanLoginFailure(new AuthenticationError('GenerateAccessToken', 'bad PIN'), async () => undefined);
    assert.match(error.message, /bad PIN/);
  });
});

describe('assertUsableToken', () => {
  const now = 1_000_000;

  it('accepts a token that expires in the future', () => {
    assert.doesNotThrow(() => assertUsableToken({ expiresAt: now + 60_000 }, now));
  });

  it('refuses a missing token', () => {
    assert.throws(() => assertUsableToken(undefined, now), /returned no token/);
  });

  it('refuses a token without an expiry, which the SDK would re-login on every request', () => {
    assert.throws(() => assertUsableToken({}, now), /without an expiry/);
  });

  it('refuses a token whose expiry did not parse to a finite time', () => {
    assert.throws(() => assertUsableToken({ expiresAt: Number.NaN }, now), /without an expiry/);
  });

  it('refuses a token that is already expired, which points at clock skew', () => {
    assert.throws(() => assertUsableToken({ expiresAt: now - 1 }, now), /already expired/);
  });
});

describe('formatExpiry', () => {
  it('renders a valid expiry as ISO time and never throws on a malformed one', () => {
    assert.equal(formatExpiry(0), '1970-01-01T00:00:00.000Z');
    assert.equal(formatExpiry(undefined), 'none');
    assert.equal(formatExpiry(Number.NaN), 'none');
  });
});

describe('singleFlight', () => {
  it('shares one in-flight run among overlapping callers', async () => {
    let runs = 0;
    const run = singleFlight(async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return runs;
    });
    const [first, second] = await Promise.all([run(), run()]);
    assert.equal(runs, 1);
    assert.equal(first, 1);
    assert.equal(second, 1);
    assert.equal(await run(), 2);
  });

  it('clears the slot after a failure so the next caller retries', async () => {
    let attempts = 0;
    const run = singleFlight(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('network');
      }
      return 'renewed';
    });
    await assert.rejects(run(), /network/);
    assert.equal(await run(), 'renewed');
    assert.equal(attempts, 2);
  });
});

describe('createDhanClient', () => {
  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
  /** Inside the SDK's five-minute renewal window, so the next request attempts a renewal. */
  const RENEWAL_DUE = new Date(Date.now() + 120_000).toISOString();
  const OTP_DHAN = {
    clientId: '1100000001',
    auth: { kind: 'otp', pin: '4321', totpSecret: RFC_SECRET },
    baseUrl: undefined,
  } as const;

  interface SdkStubs {
    readonly login?: typeof DhanAuth.generateAccessToken;
    readonly renew?: typeof DhanAuth.renewWebToken;
  }

  /** Replaces SDK HTTP calls for one test and restores them afterwards. */
  async function withSdkStubs(stubs: SdkStubs, body: () => Promise<void>): Promise<void> {
    const originalLogin = DhanAuth.generateAccessToken;
    const originalRenew = DhanAuth.renewWebToken;
    if (stubs.login !== undefined) {
      DhanAuth.generateAccessToken = stubs.login;
    }
    if (stubs.renew !== undefined) {
      DhanAuth.renewWebToken = stubs.renew;
    }
    try {
      await body();
    } finally {
      DhanAuth.generateAccessToken = originalLogin;
      DhanAuth.renewWebToken = originalRenew;
    }
  }

  function captureLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const write = (level: string) => (message: string, data?: Readonly<Record<string, unknown>>) => {
      lines.push(`${level} ${message} ${data === undefined ? '' : JSON.stringify(data)}`);
    };
    return { logger: { info: write('info'), warn: write('warn'), error: write('error') }, lines };
  }

  it('builds a plain client from a static token without any network call', async () => {
    const client = await createDhanClient({
      clientId: '1100000001',
      auth: { kind: 'static', accessToken: 'static-token' },
      baseUrl: undefined,
    });
    assert.equal(client.getConfig().token, 'static-token');
  });

  it('logs in once at startup, reuses the token for later requests, and keeps secrets out of logs', async () => {
    const { logger, lines } = captureLogger();
    let logins = 0;
    let seen: { pin?: string; totp?: string } = {};
    await withSdkStubs(
      {
        login: async (request) => {
          logins += 1;
          seen = { pin: request.pin, totp: request.totp };
          return new TokenResponse({ accessToken: 'stub-access-token', expiryTime: FUTURE });
        },
      },
      async () => {
        const client = await createDhanClient(OTP_DHAN, { logger });
        assert.equal(logins, 1);
        assert.equal(seen.pin, '4321');
        assert.match(seen.totp ?? '', /^\d{6}$/);

        // Later requests read the cached token; they must not start another login.
        const provider = client.getConfig().tokenProvider;
        assert.ok(provider !== undefined, 'tokenProvider is installed');
        assert.equal(await provider(), 'stub-access-token');
        assert.equal(logins, 1);

        // The market and order-update sockets copy the provider when the client is built. This
        // reads the SDK's internal DhanWS options, so it also guards that behaviour on SDK upgrades.
        const socketOptions = (client.ws as unknown as { options: { token?: unknown; tokenProvider?: unknown } }).options;
        assert.equal(typeof socketOptions.tokenProvider, 'function', 'WebSocket feeds receive the token provider');
        assert.equal(socketOptions.token, undefined);
      },
    );
    const logged = lines.join('\n');
    assert.match(logged, /dhan access token issued/);
    assert.equal(logged.includes('stub-access-token'), false, 'token must not be logged');
    assert.equal(logged.includes('4321'), false, 'PIN must not be logged');
    assert.equal(logged.includes(RFC_SECRET), false, 'TOTP secret must not be logged');
  });

  it('renews a token inside the renewal window and serves the renewed token', async () => {
    let renewals = 0;
    await withSdkStubs(
      {
        login: async () => new TokenResponse({ accessToken: 'first-token', expiryTime: RENEWAL_DUE }),
        renew: async () => {
          renewals += 1;
          return new TokenResponse({ accessToken: 'renewed-token', expiryTime: FUTURE });
        },
      },
      async () => {
        const client = await createDhanClient(OTP_DHAN);
        const provider = client.getConfig().tokenProvider;
        assert.ok(provider !== undefined);
        assert.equal(await provider(), 'renewed-token');
        assert.equal(renewals, 1);
      },
    );
  });

  it('keeps using a still-valid token when renewal fails on the network, and warns once', async () => {
    const { logger, lines } = captureLogger();
    let renewalAttempts = 0;
    await withSdkStubs(
      {
        login: async () => new TokenResponse({ accessToken: 'held-token', expiryTime: RENEWAL_DUE }),
        renew: async () => {
          renewalAttempts += 1;
          throw new Error('socket hang up');
        },
      },
      async () => {
        const client = await createDhanClient(OTP_DHAN, { logger });
        const provider = client.getConfig().tokenProvider;
        assert.ok(provider !== undefined);
        assert.equal(await provider(), 'held-token');
        assert.equal(await provider(), 'held-token');
        assert.equal(renewalAttempts, 2);
      },
    );
    assert.equal(lines.filter((line) => line.includes('token renewal failed')).length, 1);
  });

  it('surfaces the renewal failure once the held token has itself expired', async () => {
    let clock = Date.now();
    await withSdkStubs(
      {
        login: async () => new TokenResponse({ accessToken: 'held-token', expiryTime: RENEWAL_DUE }),
        renew: async () => {
          throw new Error('socket hang up');
        },
      },
      async () => {
        const client = await createDhanClient(OTP_DHAN, { now: () => clock });
        const provider = client.getConfig().tokenProvider;
        assert.ok(provider !== undefined);
        clock = Date.now() + 10 * 60_000;
        await assert.rejects(async () => provider(), /socket hang up/);
      },
    );
  });

  it('fails startup when the broker rejects the PIN, with the broker reason', async () => {
    await withSdkStubs(
      {
        login: async () => {
          throw new AuthenticationError('GenerateAccessToken', 'Invalid PIN');
        },
      },
      async () => {
        await assert.rejects(createDhanClient({ ...OTP_DHAN, auth: { kind: 'otp', pin: '0000', totpSecret: RFC_SECRET } }), /Invalid PIN/);
      },
    );
  });

  it('fails closed when the login returns a token with no expiry', async () => {
    await withSdkStubs(
      { login: async () => new TokenResponse({ accessToken: 'no-expiry-token' }) },
      async () => {
        await assert.rejects(createDhanClient(OTP_DHAN), /without an expiry/);
      },
    );
  });
});
