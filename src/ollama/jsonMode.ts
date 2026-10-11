import { inferRuntimeMode } from '@nemesis-oss/ollama-sdk';

/**
 * `@nemesis-oss/ollama-sdk` refuses any `format` request pre-flight against a non-local endpoint (it classifies every
 * hostname that is not localhost/loopback/RFC1918-ish as Ollama Cloud, a known cloud limitation) and the refusal would
 * silently disable the LLM layers. So JSON mode is requested only where the SDK allows it; elsewhere the prompts
 * already demand JSON and `parseJsonLoose` copes with fenced or chatty replies.
 */
export function jsonFormatFor(host: string): { format: 'json' } | Record<string, never> {
  return inferRuntimeMode(host) === 'local' ? { format: 'json' } : {};
}

/** JSON.parse that also accepts a reply wrapped in prose or a ```json fence by taking the outermost {...}. Throws when there is none. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('invalid JSON');
  }
}
