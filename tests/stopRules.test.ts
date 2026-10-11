import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directionOf, findStopExit } from '../src/binance/stopRules.js';

test('directionOf returns 1 for LONG', () => {
  assert.equal(directionOf('LONG'), 1);
});

test('directionOf returns -1 for SHORT', () => {
  assert.equal(directionOf('SHORT'), -1);
});

test('long SL breached at mark ≤ SL triggers at mark', () => {
  const exit = findStopExit({ side: 'LONG', mark: 95, serverSl: '100', serverTp: '150' });
  assert.deepEqual(exit, { price: 95, reason: 'STOP LOSS' });
});

test('long SL exactly at mark triggers at mark', () => {
  const exit = findStopExit({ side: 'LONG', mark: 100, serverSl: '100', serverTp: '150' });
  assert.deepEqual(exit, { price: 100, reason: 'STOP LOSS' });
});

test('long SL not breached returns null', () => {
  const exit = findStopExit({ side: 'LONG', mark: 105, serverSl: '100', serverTp: '150' });
  assert.equal(exit, null);
});

test('short SL breached at mark ≥ SL triggers at mark', () => {
  const exit = findStopExit({ side: 'SHORT', mark: 105, serverSl: '100', serverTp: '50' });
  assert.deepEqual(exit, { price: 105, reason: 'STOP LOSS' });
});

test('short SL exactly at mark triggers at mark', () => {
  const exit = findStopExit({ side: 'SHORT', mark: 100, serverSl: '100', serverTp: '50' });
  assert.deepEqual(exit, { price: 100, reason: 'STOP LOSS' });
});

test('short SL not breached returns null', () => {
  const exit = findStopExit({ side: 'SHORT', mark: 95, serverSl: '100', serverTp: '50' });
  assert.equal(exit, null);
});

test('long TP breached at mark ≥ TP triggers at TP level', () => {
  const exit = findStopExit({ side: 'LONG', mark: 155, serverSl: '90', serverTp: '150' });
  assert.deepEqual(exit, { price: 150, reason: 'TAKE PROFIT' });
});

test('long TP exactly at mark triggers at TP level', () => {
  const exit = findStopExit({ side: 'LONG', mark: 150, serverSl: '90', serverTp: '150' });
  assert.deepEqual(exit, { price: 150, reason: 'TAKE PROFIT' });
});

test('long TP not breached returns null', () => {
  const exit = findStopExit({ side: 'LONG', mark: 145, serverSl: '90', serverTp: '150' });
  assert.equal(exit, null);
});

test('short TP breached at mark ≤ TP triggers at TP level', () => {
  const exit = findStopExit({ side: 'SHORT', mark: 45, serverSl: '110', serverTp: '50' });
  assert.deepEqual(exit, { price: 50, reason: 'TAKE PROFIT' });
});

test('short TP exactly at mark triggers at TP level', () => {
  const exit = findStopExit({ side: 'SHORT', mark: 50, serverSl: '110', serverTp: '50' });
  assert.deepEqual(exit, { price: 50, reason: 'TAKE PROFIT' });
});

test('short TP not breached returns null', () => {
  const exit = findStopExit({ side: 'SHORT', mark: 55, serverSl: '110', serverTp: '50' });
  assert.equal(exit, null);
});

test('non-numeric SL label "—" never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 50, serverSl: '—', serverTp: '150' });
  assert.equal(exit, null);
});

test('non-numeric SL label "trail" never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 50, serverSl: 'trail', serverTp: '150' });
  assert.equal(exit, null);
});

test('non-numeric SL label "fund" never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 50, serverSl: 'fund', serverTp: '150' });
  assert.equal(exit, null);
});

test('non-numeric SL label empty string never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 50, serverSl: '', serverTp: '150' });
  assert.equal(exit, null);
});

test('non-numeric TP label "—" never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 150, serverSl: '90', serverTp: '—' });
  assert.equal(exit, null);
});

test('non-numeric TP label "trail" never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 150, serverSl: '90', serverTp: 'trail' });
  assert.equal(exit, null);
});

test('non-numeric TP labels "fund" never triggers', () => {
  const exit = findStopExit({ side: 'LONG', mark: 150, serverSl: '90', serverTp: 'fund' });
  assert.equal(exit, null);
});

test('both SL and TP non-numeric returns null', () => {
  const exit = findStopExit({ side: 'LONG', mark: 100, serverSl: 'trail', serverTp: 'fund' });
  assert.equal(exit, null);
});

test('SL breached takes priority (liquidation would be checked separately)', () => {
  const exit = findStopExit({ side: 'LONG', mark: 50, serverSl: '100', serverTp: '150' });
  assert.deepEqual(exit, { price: 50, reason: 'STOP LOSS' });
});
