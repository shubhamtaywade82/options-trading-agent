import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BarSeries, CandleBuilder } from '../src/market/barSeries.js';
import { bar, istEpoch } from './support/fixtures.js';

describe('CandleBuilder', () => {
  const FIVE_MIN = 5 * 60_000;

  it('aligns bucket starts to IST wall-clock boundaries', () => {
    const builder = new CandleBuilder(FIVE_MIN);
    assert.equal(builder.bucketStart(istEpoch('2026-10-12', '09:17')), istEpoch('2026-10-12', '09:15'));
    assert.equal(builder.bucketStart(istEpoch('2026-10-12', '09:20')), istEpoch('2026-10-12', '09:20'));
  });

  it('closes the previous bar only when a tick opens the next bucket', () => {
    const builder = new CandleBuilder(FIVE_MIN);
    assert.equal(builder.onTick({ ltp: 100, ltt: istEpoch('2026-10-12', '09:15') + 1_000 }), undefined);
    assert.equal(builder.onTick({ ltp: 103, ltt: istEpoch('2026-10-12', '09:16') }), undefined);
    assert.equal(builder.onTick({ ltp: 98, ltt: istEpoch('2026-10-12', '09:18') }), undefined);
    const closed = builder.onTick({ ltp: 101, ltt: istEpoch('2026-10-12', '09:20') });
    assert.deepEqual(closed, {
      time: istEpoch('2026-10-12', '09:15'),
      open: 100,
      high: 103,
      low: 98,
      close: 98,
      volume: 0,
    });
  });

  it('drops out-of-order ticks instead of corrupting the open bar', () => {
    const builder = new CandleBuilder(FIVE_MIN);
    builder.onTick({ ltp: 100, ltt: istEpoch('2026-10-12', '09:20') });
    assert.equal(builder.onTick({ ltp: 50, ltt: istEpoch('2026-10-12', '09:16') }), undefined);
    assert.equal(builder.droppedLateTicks, 1);
    const closed = builder.onTick({ ltp: 101, ltt: istEpoch('2026-10-12', '09:25') });
    assert.equal(closed?.low, 100);
  });

  it('ignores non-positive or non-finite prices', () => {
    const builder = new CandleBuilder(FIVE_MIN);
    assert.equal(builder.onTick({ ltp: 0, ltt: istEpoch('2026-10-12', '09:15') }), undefined);
    assert.equal(builder.onTick({ ltp: Number.NaN, ltt: istEpoch('2026-10-12', '09:15') }), undefined);
    assert.equal(builder.flush(istEpoch('2026-10-12', '09:30')), undefined);
  });

  it('flushes a quiet bar once wall-clock time passes its end', () => {
    const builder = new CandleBuilder(FIVE_MIN);
    builder.onTick({ ltp: 100, ltt: istEpoch('2026-10-12', '09:15') });
    assert.equal(builder.flush(istEpoch('2026-10-12', '09:19')), undefined);
    assert.equal(builder.flush(istEpoch('2026-10-12', '09:20'))?.close, 100);
    assert.equal(builder.flush(istEpoch('2026-10-12', '09:25')), undefined, 'a flushed bar is not emitted twice');
  });
});

describe('BarSeries', () => {
  it('replaces a bar that re-arrives at the same open time', () => {
    const series = new BarSeries();
    series.upsert(bar(1, 10, 11, 9, 10));
    series.upsert(bar(1, 10, 12, 9, 11));
    assert.equal(series.length, 1);
    assert.equal(series.last?.high, 12);
  });

  it('refuses bars older than the newest stored bar', () => {
    const series = new BarSeries();
    series.upsert(bar(2, 10, 11, 9, 10));
    assert.equal(series.upsert(bar(1, 10, 11, 9, 10)), false);
    assert.equal(series.length, 1);
  });

  it('bounds memory by capacity, keeping the newest bars', () => {
    const series = new BarSeries(3);
    for (let t = 1; t <= 5; t += 1) {
      series.upsert(bar(t, 1, 1, 1, 1));
    }
    assert.deepEqual(series.all().map((candle) => candle.time), [3, 4, 5]);
  });
});
