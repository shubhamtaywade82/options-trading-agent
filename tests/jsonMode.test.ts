import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonFormatFor, parseJsonLoose } from '../src/ollama/jsonMode.js';

test('should ask for JSON mode on loopback and private hosts, which the SDK serves as local', () => {
  for (const host of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://192.168.1.20:11434', 'http://10.0.0.5:11434', 'http://box.local:11434']) {
    assert.deepEqual(jsonFormatFor(host), { format: 'json' }, host);
  }
});

test('should not send a format to hosts the SDK classifies as cloud (it refuses them pre-flight)', () => {
  // '[::1]': the SDK compares URL.hostname, which keeps the brackets, to '::1' and so classifies IPv6 loopback as cloud
  for (const host of ['https://ollama.com', 'http://gpu-box.example.net:11434', 'http://172.16.0.9:11434', 'http://[::1]:11434']) {
    assert.deepEqual(jsonFormatFor(host), {}, host);
  }
});

test('should not send a format for an unparseable host', () => {
  assert.deepEqual(jsonFormatFor('not a url'), {});
});

test('should parse plain, fenced and prose-wrapped JSON objects and throw otherwise', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('  {"a":1}\n'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.deepEqual(parseJsonLoose('Sure! {"a":1} Hope that helps'), { a: 1 });
  assert.throws(() => parseJsonLoose('no braces'), /invalid JSON/);
  assert.throws(() => parseJsonLoose('{broken'), /invalid JSON/);
  assert.throws(() => parseJsonLoose(''), /invalid JSON/);
});
