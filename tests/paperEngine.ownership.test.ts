import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PaperEngine } from '../src/binance/paperEngine.js';
import { OwnershipError } from '../src/binance/remoteOrders.js';

const long = { symbol: 'BTCUSDT', side: 'BUY' as const, qty: 1, leverage: 5, entryPrice: 100 };
const engine = () => new PaperEngine(path.join(mkdtempSync(path.join(tmpdir(), 'paper-')), 'state.json'));

test('should refuse a second strategy on a symbol another strategy holds, opposite side or not', () => {
  const paper = engine();
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ' });
  assert.throws(() => paper.openPosition({ ...long, strategy: 'ADAPTIVE-ST-ζ', side: 'SELL' }), OwnershipError);
  assert.throws(() => paper.openPosition({ ...long, strategy: 'ADAPTIVE-ST-ζ' }), OwnershipError);
  assert.equal(paper.getPositions().length, 1);
  assert.equal(paper.getPositions()[0].strategy, 'MOMENTUM-γ');
});

test('should let the owner scale in, flip, and close, and free the symbol after the close', () => {
  const paper = engine();
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ' });
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ', qty: 2 });
  assert.equal(paper.getPositions()[0].qty, 3);
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ', side: 'SELL', qty: 1 });
  assert.equal(paper.getPositions()[0].side, 'SHORT');
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ', side: 'BUY', qty: 1, reduceOnly: true });
  assert.equal(paper.getPositions().length, 0);
  paper.openPosition({ ...long, strategy: 'ADAPTIVE-ST-ζ', side: 'SELL' });
  assert.equal(paper.getPositions()[0].strategy, 'ADAPTIVE-ST-ζ');
});

test('should let different strategies hold different symbols, and never block a reduce-only close', () => {
  const paper = engine();
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ' });
  paper.openPosition({ ...long, strategy: 'ADAPTIVE-ST-ζ', symbol: 'ETHUSDT' });
  assert.equal(paper.getPositions().length, 2);
  paper.openPosition({ ...long, strategy: 'MOMENTUM-γ', side: 'SELL', reduceOnly: true });
  assert.equal(paper.getPositions().length, 1);
});
