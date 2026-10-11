import { PaperExchangeClient, type PaperExchangePosition, type PaperExchangeAccountSnapshot } from '../binance/paperExchangeClient.js';
import { wilderAtr } from '../binance/indicators.js';
import { MiniCpmService } from './MiniCpmService.js';
import type { LlmTradeRecommendation, PromptInput } from './MiniCpmPrompt.js';
import type { Candle } from '../types.js';
import type { MarketState } from '../market/types.js';
import { loadMiniCpmState, saveMiniCpmPosition, removeMiniCpmPosition } from './MiniCpmStateStore.js';

export interface SymbolWorkerConfig {
  symbol: string;
  accountId: string;
  paperExchangeUrl: string;
  apiKey: string;
  marginPerPosition: number;
  leverage: number;
}

export interface WorkerStatus {
  symbol: string;
  accountId: string;
  state: 'IDLE' | 'ANALYZING' | 'IN_POSITION';
  activePosition: PaperExchangePosition | null;
  account: PaperExchangeAccountSnapshot | null;
  stopLoss: number | null;
  takeProfit: number | null;
  slDistancePct: number | null;
  tpDistancePct: number | null;
  breakEvenMoved: boolean;
  lastDecision: string;
  lastUpdated: number;
}

export interface EvaluationParams {
  markPrice: number;
  btcCandles15m: Candle[];
  btcCandles1h: Candle[];
  symbolCandles15m: Candle[];
  symbolCandles1h: Candle[];
  marketState?: MarketState;
}

export class SymbolTraderWorker {
  private readonly client: PaperExchangeClient;
  private readonly llm: MiniCpmService;
  private status: WorkerStatus;
  private currentSl: number | null = null;
  private currentTp: number | null = null;
  private breakEvenMoved = false;

  constructor(
    private readonly config: SymbolWorkerConfig,
    llm: MiniCpmService,
  ) {
    this.llm = llm;
    this.client = new PaperExchangeClient(config.paperExchangeUrl, config.accountId, {
      apiKey: config.apiKey,
    });
    this.status = {
      symbol: config.symbol,
      accountId: config.accountId,
      state: 'IDLE',
      activePosition: null,
      account: null,
      stopLoss: null,
      takeProfit: null,
      slDistancePct: null,
      tpDistancePct: null,
      breakEvenMoved: false,
      lastDecision: 'Initialized',
      lastUpdated: Date.now(),
    };

    const saved = loadMiniCpmState().positions[config.symbol];
    if (saved) {
      this.currentSl = saved.stopLoss;
      this.currentTp = saved.takeProfit;
      this.breakEvenMoved = !!saved.breakEvenMoved;
      this.status.lastDecision = `Recovered: SL $${saved.stopLoss} | TP $${saved.takeProfit}`;
    }
  }

  getStatus(): WorkerStatus {
    return { ...this.status };
  }

  async syncAccount(): Promise<void> {
    try {
      const acct = await this.client.getAccount();
      if (!acct) {
        await this.client.createAccount(this.config.marginPerPosition);
        this.status.account = await this.client.getAccount();
      } else {
        this.status.account = acct;
      }

      const positions = await this.client.getPositions();
      const pos = positions.find((p) => p.symbol === this.config.symbol && p.netQuantity > 0);
      this.status.activePosition = pos ?? null;
      this.status.state = pos ? 'IN_POSITION' : 'IDLE';

      if (!pos && (this.currentSl !== null || this.currentTp !== null)) {
        this.currentSl = null;
        this.currentTp = null;
        this.breakEvenMoved = false;
        removeMiniCpmPosition(this.config.symbol);
      }

      this.updateStatusLevels(pos ? pos.currentPrice : null);
      this.status.lastUpdated = Date.now();
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] sync error:`, (err as Error).message);
    }
  }

  async onLiveTick(price: number): Promise<void> {
    const pos = this.status.activePosition;
    if (!pos) return;

    pos.currentPrice = price;
    const isLong = pos.side === 'long';
    const delta = isLong ? price - pos.averagePrice : pos.averagePrice - price;
    pos.unrealizedPnl = Number((delta * pos.netQuantity).toFixed(2));
    this.updateStatusLevels(price);
    await this.manageOpenPosition(price);
  }

  async evaluate(params: EvaluationParams): Promise<void> {
    const { markPrice } = params;
    await this.client.pushMarkPrices({ [this.config.symbol]: markPrice });
    await this.syncAccount();

    if (this.status.activePosition) {
      this.ensureRecoveryLevels(markPrice);
      await this.manageOpenPosition(markPrice);
      return;
    }

    const input = this.buildPromptInput(params);
    if (!input) return;

    this.status.state = 'ANALYZING';
    const rec = await this.llm.analyze(input);
    if (!rec || rec.action === 'HOLD') {
      this.status.state = 'IDLE';
      this.status.lastDecision = rec ? `HOLD: ${rec.reason}` : 'No setup approved';
      return;
    }

    await this.executeEntry(rec, markPrice);
  }

  // Establishes default bounds when an exchange position exists without local stop levels
  private ensureRecoveryLevels(markPrice: number): void {
    if (this.currentSl !== null && this.currentTp !== null) return;
    const isLong = this.status.activePosition?.side === 'long';
    this.currentSl = isLong ? Number((markPrice * 0.985).toFixed(4)) : Number((markPrice * 1.015).toFixed(4));
    this.currentTp = isLong ? Number((markPrice * 1.01).toFixed(4)) : Number((markPrice * 0.99).toFixed(4));
    saveMiniCpmPosition({
      symbol: this.config.symbol,
      entryPrice: this.status.activePosition?.averagePrice ?? markPrice,
      stopLoss: this.currentSl,
      takeProfit: this.currentTp,
      breakEvenMoved: false,
      openedAt: Date.now(),
      reason: 'Auto-anchored recovery levels',
    });
  }

  private async executeEntry(rec: LlmTradeRecommendation, markPrice: number): Promise<void> {
    const notional = this.config.marginPerPosition * 0.98 * this.config.leverage;
    const quantity = Number((notional / markPrice).toFixed(4));
    const side = rec.action === 'ENTER_LONG' ? 'buy' : 'sell';
    this.status.lastDecision = `${rec.action} @ ${markPrice} | SL: ${rec.stopLoss} | TP: ${rec.takeProfit} (${rec.reason})`;

    try {
      const order = await this.client.submitOrder({
        symbol: this.config.symbol,
        side,
        quantity,
        leverage: this.config.leverage,
        marginType: 'isolated',
        executionPrice: markPrice,
        clientOrderId: `minicpm-${this.config.symbol}-${Date.now()}`,
      });

      if (order.status === 'FILLED' || order.orderId > 0) {
        this.currentSl = rec.stopLoss;
        this.currentTp = rec.takeProfit;
        this.breakEvenMoved = false;
        this.status.state = 'IN_POSITION';
        saveMiniCpmPosition({
          symbol: this.config.symbol,
          entryPrice: markPrice,
          stopLoss: rec.stopLoss,
          takeProfit: rec.takeProfit,
          breakEvenMoved: false,
          openedAt: Date.now(),
          reason: rec.reason,
        });
        await this.syncAccount();
      }
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] order error:`, (err as Error).message);
    }
  }

  private updateStatusLevels(currentPrice: number | null): void {
    this.status.stopLoss = this.currentSl;
    this.status.takeProfit = this.currentTp;
    this.status.breakEvenMoved = this.breakEvenMoved;

    if (currentPrice && this.currentSl !== null && this.currentTp !== null) {
      this.status.slDistancePct = Number((((this.currentSl - currentPrice) / currentPrice) * 100).toFixed(2));
      this.status.tpDistancePct = Number((((this.currentTp - currentPrice) / currentPrice) * 100).toFixed(2));
    } else {
      this.status.slDistancePct = null;
      this.status.tpDistancePct = null;
    }
  }

  private async manageOpenPosition(currentPrice: number): Promise<void> {
    const pos = this.status.activePosition;
    if (!pos || this.currentSl === null || this.currentTp === null) return;

    this.applyTrailingBreakEven(pos, currentPrice);

    const isLong = pos.side === 'long';
    const hitSl = isLong ? currentPrice <= this.currentSl : currentPrice >= this.currentSl;
    const hitTp = isLong ? currentPrice >= this.currentTp : currentPrice <= this.currentTp;
    if (!hitSl && !hitTp) return;

    const exitSide = isLong ? 'sell' : 'buy';
    const isBe = this.breakEvenMoved && this.currentSl === pos.averagePrice;
    const reason = hitSl ? (isBe ? 'BREAK_EVEN' : 'STOP_LOSS') : 'TAKE_PROFIT';
    await this.closePosition(pos, exitSide, reason, currentPrice);
  }

  // Locks profit once price moves at least 0.25% in favor (2.5% return on 10x margin)
  private applyTrailingBreakEven(pos: PaperExchangePosition, currentPrice: number): void {
    if (this.breakEvenMoved) return;
    const isLong = pos.side === 'long';
    const gainPct = isLong
      ? ((currentPrice - pos.averagePrice) / pos.averagePrice) * 100
      : ((pos.averagePrice - currentPrice) / pos.averagePrice) * 100;
    if (gainPct < 0.25) return;

    this.currentSl = pos.averagePrice;
    this.breakEvenMoved = true;
    this.status.breakEvenMoved = true;
    this.status.lastDecision = `Moved SL to Break-Even ($${pos.averagePrice.toFixed(2)}) after +${(gainPct * 10).toFixed(1)}% profit move`;
    saveMiniCpmPosition({
      symbol: this.config.symbol,
      entryPrice: pos.averagePrice,
      stopLoss: this.currentSl,
      takeProfit: this.currentTp!,
      breakEvenMoved: true,
      openedAt: Date.now(),
      reason: 'Shifted to Break-Even',
    });
  }

  private async closePosition(
    pos: PaperExchangePosition,
    side: 'buy' | 'sell',
    reason: string,
    currentPrice: number,
  ): Promise<void> {
    this.status.lastDecision = `CLOSING (${reason}) @ ${currentPrice}`;
    try {
      await this.client.submitOrder({
        symbol: this.config.symbol,
        side,
        quantity: pos.netQuantity,
        leverage: this.config.leverage,
        marginType: 'isolated',
        reduceOnly: true,
        executionPrice: currentPrice,
        clientOrderId: `minicpm-close-${this.config.symbol}-${Date.now()}`,
      });
      this.currentSl = null;
      this.currentTp = null;
      this.breakEvenMoved = false;
      removeMiniCpmPosition(this.config.symbol);
      await this.syncAccount();
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] exit error:`, (err as Error).message);
    }
  }

  private buildPromptInput(params: EvaluationParams): PromptInput | null {
    const { markPrice, btcCandles15m, btcCandles1h, symbolCandles15m, symbolCandles1h, marketState } = params;
    if (btcCandles15m.length < 20 || btcCandles1h.length < 10 || symbolCandles15m.length < 20 || symbolCandles1h.length < 10) {
      return null;
    }

    const atr14 = marketState?.timeframes['15m'].atr14 ?? (wilderAtr(symbolCandles15m, 14).at(-1) ?? 1.0);
    return {
      symbol: this.config.symbol,
      currentPrice: markPrice,
      btcContext: this.buildBtcContext(btcCandles15m, btcCandles1h),
      symbolContext: this.buildSymbolContext(markPrice, symbolCandles15m, symbolCandles1h, atr14),
      marketState,
    };
  }

  private buildBtcContext(btc15m: Candle[], btc1h: Candle[]) {
    const last = btc15m.at(-1)!;
    const open24h = btc1h.length >= 24 ? btc1h.at(-24)!.open : btc1h[0]!.open;
    return {
      price: last.close,
      trend1h: this.detectTrend(btc1h),
      trend15m: this.detectTrend(btc15m),
      change24hPct: ((last.close - open24h) / open24h) * 100,
    };
  }

  private buildSymbolContext(markPrice: number, sym15m: Candle[], sym1h: Candle[], atr14: number) {
    const open24h = sym1h.length >= 24 ? sym1h.at(-24)!.open : sym1h[0]!.open;
    const recentHigh = Math.max(...sym15m.slice(-20).map((c) => c.high));
    const recentLow = Math.min(...sym15m.slice(-20).map((c) => c.low));
    return {
      price: markPrice,
      trend1h: this.detectTrend(sym1h),
      trend15m: this.detectTrend(sym15m),
      change24hPct: ((markPrice - open24h) / open24h) * 100,
      atr14,
      support: recentLow,
      resistance: recentHigh,
      recentHigh,
      recentLow,
    };
  }

  private detectTrend(candles: Candle[]): 'BULLISH' | 'BEARISH' | 'SIDEWAYS' {
    if (candles.length < 5) return 'SIDEWAYS';
    const first = candles.at(-5)!.close;
    const last = candles.at(-1)!.close;
    const diffPct = ((last - first) / first) * 100;
    if (diffPct > 0.3) return 'BULLISH';
    if (diffPct < -0.3) return 'BEARISH';
    return 'SIDEWAYS';
  }
}
