export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function sampleStd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

export function trueRange(high: number, low: number, previousClose?: number): number {
  if (previousClose === undefined) return high - low;
  return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
}

export function atrSeries(candles: { high: number; low: number; close: number }[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(candles.length).fill(null);
  if (candles.length < period) return out;

  const tr: number[] = candles.map((c, i) =>
    trueRange(c.high, c.low, i === 0 ? undefined : candles[i - 1].close),
  );
  let rma = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = rma;

  for (let i = period; i < candles.length; i++) {
    rma = ((rma * (period - 1)) + tr[i]) / period;
    out[i] = rma;
  }

  return out;
}

export function changeStdAt(
  closes: number[],
  index: number,
  window = 100,
): number | null {
  const start = Math.max(1, index - window + 1);
  const changes: number[] = [];
  for (let i = start; i <= index; i++) changes.push(closes[i] - closes[i - 1]);
  return sampleStd(changes);
}

function normalCdf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p =
    1 -
    d *
      t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}

export function clampProbability(p: number): number {
  return Math.max(0.005, Math.min(0.995, p));
}

/** Reflection-principle probability that a driftless random walk touches d within w bars. */
export function touchProbability(d: number, sd: number | null, w: number): number | null {
  if (sd === null || sd <= 0 || !Number.isFinite(d) || d < 0 || w <= 0) return null;
  return clampProbability(2 * (1 - normalCdf(d / (sd * Math.sqrt(w)))));
}

export class BayesianLogisticCalibration {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private a = 0;
  private b = 1;
  private sumOdds = 0;
  private sumModelBrier = 0;
  private sumFormulaBrier = 0;
  private sumBaseBrier = 0;
  private hits = 0;

  constructor(
    private readonly lambda = 50,
    private readonly cap = 500,
    private readonly fixedIntercept = false,
  ) {}

  get samples(): number {
    return this.ys.length;
  }

  predict(p0: number | null): number | null {
    if (p0 === null) return null;
    if (this.xs.length === 0 && this.a === 0 && this.b === 1) return p0;
    const x = logit(p0);
    const z = Math.max(-30, Math.min(30, this.a + this.b * x));
    return 1 / (1 + Math.exp(-z));
  }

  score(pModel: number, pFormula: number, outcome: 0 | 1): void {
    const base = this.samples > 0 ? this.hits / this.samples : 0.5;
    this.sumBaseBrier += (base - outcome) ** 2;
    this.sumModelBrier += (pModel - outcome) ** 2;
    this.sumFormulaBrier += (pFormula - outcome) ** 2;
    this.sumOdds += pModel;
    this.hits += outcome;

    this.xs.push(logit(pFormula));
    this.ys.push(outcome);
    if (this.xs.length > this.cap) {
      this.xs.shift();
      this.ys.shift();
    }
    this.fit();
  }

  summary() {
    const n = this.samples;
    return {
      samples: n,
      hitRate: n ? this.hits / n : null,
      brierModel: n ? this.sumModelBrier / n : null,
      brierFormula: n ? this.sumFormulaBrier / n : null,
      brierBase: n ? this.sumBaseBrier / n : null,
    };
  }

  private fit(): void {
    if (this.xs.length === 0) return;

    let a = this.a;
    let b = this.b;
    for (let iteration = 0; iteration < 4; iteration++) {
      let ga = this.lambda * a;
      let gb = this.lambda * (b - 1);
      let haa = this.lambda;
      let hab = 0;
      let hbb = this.lambda;

      for (let i = 0; i < this.xs.length; i++) {
        const x = this.xs[i];
        const y = this.ys[i];
        const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, a + b * x))));
        const e = p - y;
        const w = p * (1 - p);

        ga += e;
        gb += e * x;
        haa += w;
        hab += w * x;
        hbb += w * x * x;
      }

      if (this.fixedIntercept) {
        if (hbb > 0) b -= gb / hbb;
      } else {
        const det = haa * hbb - hab * hab;
        if (det > 0) {
          a -= (hbb * ga - hab * gb) / det;
          b -= (haa * gb - hab * ga) / det;
        }
      }
      b = Math.max(0.05, Math.min(4, b));
    }

    this.a = a;
    this.b = b;
  }
}

function logit(p: number): number {
  const q = clampProbability(p);
  return Math.log(q / (1 - q));
}


export class CausalBayesianCalibration {
  private readonly pending: Array<{
    resolvedIndex: number;
    modelProbability: number;
    formulaProbability: number;
    outcome: 0 | 1;
  }> = [];

  constructor(
    private readonly calibration: BayesianLogisticCalibration = new BayesianLogisticCalibration(),
  ) {}

  observe(
    signalIndex: number,
    formulaProbability: number | null,
    resolvedIndex: number | null,
    outcome: 0 | 1 | null,
  ): number | null {
    this.flush(signalIndex);

    const modelProbability = this.calibration.predict(formulaProbability);
    if (
      modelProbability !== null &&
      formulaProbability !== null &&
      outcome !== null &&
      resolvedIndex !== null
    ) {
      if (resolvedIndex <= signalIndex) {
        this.calibration.score(modelProbability, formulaProbability, outcome);
      } else {
        this.pending.push({
          resolvedIndex,
          modelProbability,
          formulaProbability,
          outcome,
        });
      }
    }

    return modelProbability;
  }

  finalize(): void {
    this.flush(Number.MAX_SAFE_INTEGER);
  }

  predict(formulaProbability: number | null): number | null {
    return this.calibration.predict(formulaProbability);
  }

  summary() {
    return this.calibration.summary();
  }

  private flush(signalIndex: number): void {
    if (this.pending.length === 0) return;

    this.pending.sort((a, b) => a.resolvedIndex - b.resolvedIndex);
    let consumed = 0;
    for (const observation of this.pending) {
      if (observation.resolvedIndex > signalIndex) break;
      this.calibration.score(
        observation.modelProbability,
        observation.formulaProbability,
        observation.outcome,
      );
      consumed += 1;
    }

    if (consumed > 0) this.pending.splice(0, consumed);
  }
}

export function twoProportionZ(
  nA: number,
  hitA: number,
  nB: number,
  hitB: number,
): number | null {
  if (nA < 10 || nB < 10) return null;
  const pooled = (hitA + hitB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se <= 0) return 0;
  return (hitA / nA - hitB / nB) / se;
}
