import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { AgentConfig } from '../config.js';

/**
 * Builds the SDK client. Credentials come only from validated config. The
 * SDK's own retry policy already guarantees that trading writes are sent at
 * most once, so no retry wrapper is layered on top of order placement.
 */
export function createDhanClient(dhan: AgentConfig['dhan']): DhanClient {
  return new DhanClient({
    clientId: dhan.clientId,
    token: dhan.accessToken,
    ...(dhan.baseUrl === undefined ? {} : { baseURL: dhan.baseUrl }),
  });
}
