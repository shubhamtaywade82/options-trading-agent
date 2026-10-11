import type { MarketState } from '../market/types.js';

export interface LlmTradeRecommendation {
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
}

export interface PromptInput {
  symbol: string;
  currentPrice: number;
  btcContext: {
    price: number;
    trend1h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    trend15m: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    change24hPct: number;
  };
  symbolContext: {
    price: number;
    trend1h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    trend15m: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    change24hPct: number;
    atr14: number;
    support: number;
    resistance: number;
    recentHigh: number;
    recentLow: number;
  };
  /** Rich market intelligence from the deterministic engine. */
  marketState?: MarketState;
}

const TRADE_CONSTRAINTS = `### TRADE OBJECTIVES & MANDATORY CONSTRAINTS:
1. Minimum Profit Target: At 10x leverage, Take Profit (TP) requires at least 0.5% price distance.
   - For LONG: takeProfit >= currentPrice * 1.005
   - For SHORT: takeProfit <= currentPrice * 0.995
2. Stop Loss (SL):
   - For LONG: stopLoss below local support/swing low (currentPrice > stopLoss).
   - For SHORT: stopLoss above local resistance/swing high (currentPrice < stopLoss).
   - Minimum Risk/Reward Ratio: (Reward / Risk) must be >= 1.5.
3. Decision: Output "ENTER_LONG", "ENTER_SHORT", or "HOLD" if setup is unclear or suboptimal.`;

function fmtNum(n: number | null | undefined, digits = 4): string {
  return n != null && Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function buildMarketIntelSection(state: MarketState): string {
  const { regime, htfStructure, ltfStructure, liquidity, meanReversion, crowding, pricing } = state;
  const tf15 = state.timeframes['15m'];
  const tf1h = state.timeframes['1h'];

  const sweeps = liquidity.ltf.latestSweeps.length > 0
    ? liquidity.ltf.latestSweeps.map((s) => `${s.direction}@${s.level.toFixed(2)}`).join(', ')
    : 'none';
  const pools = liquidity.htf.pools.slice(0, 3).map((p) => `${p.type}@${p.price.toFixed(2)}`).join(', ') || 'none';
  const crowd = crowding
    ? `${crowding.positioningExtreme} | funding-pct ${fmtNum(crowding.fundingPercentile, 0)} | OI-exp ${crowding.openInterestExpansion}`
    : 'n/a';

  return `### MARKET INTELLIGENCE (deterministic engine):
Regime : ${regime.regime} (${regime.trendDirection}, ADX ${fmtNum(regime.adx14, 1)}, vol-pct ${fmtNum(regime.volatilityPercentile, 0)})
HTF structure : ${htfStructure.trend} | last-break ${htfStructure.lastBreak ? `${htfStructure.lastBreak.type}-${htfStructure.lastBreak.direction}` : 'none'}
LTF structure : ${ltfStructure.trend} | last-break ${ltfStructure.lastBreak ? `${ltfStructure.lastBreak.type}-${ltfStructure.lastBreak.direction}` : 'none'}
LTF sweeps    : ${sweeps}
HTF liq pools : ${pools}
Premium/disc  : pos ${fmtNum(pricing.positionPct, 0)}% — ${pricing.premium ? 'PREMIUM' : pricing.discount ? 'DISCOUNT' : 'EQUILIBRIUM'}
MR z-score    : ${fmtNum(meanReversion.zscore, 2)} | RSI14 ${fmtNum(meanReversion.rsi14, 1)} | dev ${fmtNum(meanReversion.deviationPct, 2)}%
ATR14 (15m)   : ${fmtNum(tf15.atr14)} | ATR14 (1h) ${fmtNum(tf1h.atr14)}
Funding       : ${(state.fundingRate * 100).toFixed(4)}%
Crowding      : ${crowd}`;
}

export function buildTradingPrompt(input: PromptInput): string {
  const intel = input.marketState ? `\n${buildMarketIntelSection(input.marketState)}\n` : '';
  const { symbol, symbolContext: s, btcContext: b } = input;

  return `You are an elite quantitative crypto trader operating with 10x leverage on Binance USDT-Margined Futures.
Analyze market data for ${symbol} using BTCUSDT as macro context anchor.

### MACRO CONTEXT (BTCUSDT Anchor):
- BTC Price: $${b.price.toFixed(2)} | 1h: ${b.trend1h} | 15m: ${b.trend15m} | 24h: ${b.change24hPct.toFixed(2)}%

### ASSET DATA (${symbol}):
- Current Price: $${s.price} | 1h: ${s.trend1h} | 15m: ${s.trend15m} | 24h: ${s.change24hPct.toFixed(2)}%
- ATR(14): ${s.atr14.toFixed(4)} | Support: ${s.support} | Resistance: ${s.resistance}
- Swing High: ${s.recentHigh} | Swing Low: ${s.recentLow}
${intel}
${TRADE_CONSTRAINTS}

Return ONLY a valid JSON object with EXACTLY this structure (no markdown fences, no explanatory text):
{
  "action": "ENTER_LONG" | "ENTER_SHORT" | "HOLD",
  "confidence": 0.85,
  "entry": ${s.price},
  "stopLoss": 0.0,
  "takeProfit": 0.0,
  "reason": "Brief technical rationale"
}`;
}
