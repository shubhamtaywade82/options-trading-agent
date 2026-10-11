import 'dotenv/config';

interface TestResult {
  keyIndex: number;
  model: string;
  ok: boolean;
  status: number;
  durationMs: number;
  responsePreview: string;
  error?: string;
}

const CLOUD_MODELS = [
  'gemma4:31b',
  'gpt-oss:120b',
  'gpt-oss:20b',
  'nemotron-3-nano:30b',
  'nemotron-3-super',
  'nemotron-3-ultra',
];

const OLLAMA_HOST = 'https://ollama.com';

function getApiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const k = process.env[`OLLAMA_API_KEY_${i}`]?.trim();
    if (k) keys.push(k);
  }
  return keys;
}

async function queryOllama(
  apiKey: string,
  model: string,
  prompt: string,
  jsonFormat = false,
  timeoutMs = 30_000
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${CLOUD_MODELS_ENDPOINT}/api/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: jsonFormat ? 'json' : undefined,
      }),
      signal: controller.signal,
    });

    const body = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, text: '', error: `HTTP ${res.status}: ${body.slice(0, 100)}` };
    }

    const data = JSON.parse(body);
    return { ok: true, status: res.status, text: data.response ?? '' };
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    return { ok: false, status: isTimeout ? 408 : 0, text: '', error: isTimeout ? 'Timed out' : err?.message };
  } finally {
    clearTimeout(timer);
  }
}

const CLOUD_MODELS_ENDPOINT = OLLAMA_HOST;

async function testKey(key: string, index: number, model: string): Promise<TestResult> {
  const start = Date.now();
  const result = await queryOllama(key, model, 'Respond with exactly: PING_OK', false, 15_000);
  const durationMs = Date.now() - start;

  return {
    keyIndex: index,
    model,
    ok: result.ok,
    status: result.status,
    durationMs,
    responsePreview: result.text.trim().slice(0, 60),
    error: result.error,
  };
}

async function testJsonVeto(key: string, model: string): Promise<TestResult> {
  const start = Date.now();
  const prompt = 'You review a proposed crypto entry. Reply JSON only: {"verdict":"PROCEED"|"VETO","reason":"<max 10 words>"}';
  const result = await queryOllama(key, model, prompt, true, 20_000);
  const durationMs = Date.now() - start;

  return {
    keyIndex: 0,
    model,
    ok: result.ok,
    status: result.status,
    durationMs,
    responsePreview: result.text.trim().slice(0, 80),
    error: result.error,
  };
}

async function main() {
  const keys = getApiKeys();
  console.log(`\n=== OLLAMA CLOUD MULTI-KEY & MODEL TEST ===`);
  console.log(`Host: ${OLLAMA_HOST}`);
  console.log(`Loaded ${keys.length} API keys from .env\n`);

  if (keys.length === 0) {
    console.error('No OLLAMA_API_KEY_1..5 found in .env');
    process.exit(1);
  }

  // 1. Verify all 5 keys using the fastest model
  console.log(`--- 1. Testing all ${keys.length} API Keys (model: nemotron-3-nano:30b) ---`);
  for (let i = 0; i < keys.length; i++) {
    const masked = `${keys[i].slice(0, 6)}...${keys[i].slice(-6)}`;
    process.stdout.write(`Key #${i + 1} (${masked}): `);
    const res = await testKey(keys[i], i + 1, 'nemotron-3-nano:30b');
    if (res.ok) {
      console.log(`[PASS] (${res.durationMs}ms) -> "${res.responsePreview}"`);
    } else {
      console.log(`[FAIL] (${res.durationMs}ms) -> ${res.error}`);
    }
  }

  // 2. Test each of the requested models
  console.log(`\n--- 2. Testing All Cloud Models (Round-robin across keys) ---`);
  for (let m = 0; m < CLOUD_MODELS.length; m++) {
    const model = CLOUD_MODELS[m];
    const key = keys[m % keys.length];
    process.stdout.write(`Model [${model.padEnd(20)}]: `);
    const res = await testKey(key, (m % keys.length) + 1, model);
    if (res.ok) {
      console.log(`[AVAILABLE] (${res.durationMs}ms) -> "${res.responsePreview.replace(/\n/g, ' ')}"`);
    } else {
      console.log(`[FAILED] -> ${res.error}`);
    }
  }

  // 3. Test Structured JSON response format for trading advisor
  console.log(`\n--- 3. Testing Advisor Structured JSON Format ---`);
  for (let m = 0; m < CLOUD_MODELS.length; m++) {
    const model = CLOUD_MODELS[m];
    const key = keys[m % keys.length];
    process.stdout.write(`JSON Veto [${model.padEnd(20)}]: `);
    const res = await testJsonVeto(key, model);
    if (res.ok) {
      console.log(`[OK] (${res.durationMs}ms) -> ${res.responsePreview}`);
    } else {
      console.log(`[ERR] -> ${res.error}`);
    }
  }

  console.log('\n=== Test Completed ===\n');
}

main().catch(console.error);
