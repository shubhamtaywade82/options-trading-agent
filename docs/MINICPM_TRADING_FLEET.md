# MiniCPM-2B Autonomous 24/7 Multi-Symbol Trading Fleet

A real-time, autonomous trading agent running on Binance USD-M Futures market data and powered by a local `openbmb/minicpm5-2b:latest` (Ollama) model, connected to isolated accounts on `paper_exchange`.

---

## 1. Architectural Overview

```
                      ┌──────────────────────────────────────────────┐
                      │             Binance Market Data              │
                      │  - Real-time Sub-Second WebSocket Trades     │
                      │  - 15m & 1h Candles (multi-timeframe)        │
                      └──────────────────────┬───────────────────────┘
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │         BTC Market Context Aggregator        │
                      │   (BTCUSDT used strictly as macro anchor)    │
                      └──────────────────────┬───────────────────────┘
                                             │
                ┌────────────────────────────┼────────────────────────────┐
                ▼                            ▼                            ▼
       [ ETHUSDT Worker ]           [ SOLUSDT Worker ]           [ XRPUSDT Worker ]
      Account: `...-eth`           Account: `...-sol`           Account: `...-xrp`
                │                            │                            │
                └────────────────────────────┼────────────────────────────┘
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │        Local LLM (minicpm5-2b:latest)        │
                      │   - Dynamic SL / TP / Entry Decision         │
                      │   - Min 5% Return on Capital Target          │
                      └──────────────────────┬───────────────────────┘
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │           paper_exchange Execution           │
                      │   - $980.00 Margin per position              │
                      │   - 10x Isolated Leverage                    │
                      │   - Instant WebSocket SL/TP Triggers         │
                      │   - Real-Time Live TUI Dashboard             │
                      └──────────────────────────────────────────────┘
```

---

## 2. Capital & Margin Allocation ($980 Margin on $1,000 Account)

### Sizing Mechanics
* **Account Initial Balance**: **$1,000.00 USD** per symbol account.
* **Effective Margin Used**: **$980.00 USD** (98% of total account capital).
* **Position Leverage**: **10x Isolated**.
* **Position Notional**: **$9,800.00 USD** ($980 × 10).
* **Buffer Kept in Cash**: **$20.00 USD** (2%).

### Why Reserve a $20.00 Fee Buffer?
When opening a futures position, the exchange validates available balance before placing the fill:
$$\text{Required Balance} = \text{Initial Margin} + \text{Taker Fee}$$

If the system committed 100% ($1,000.00) to margin:
1. At 10x leverage, notional is $10,000.00.
2. The taker fee (~0.04% – 0.05%) requires ~$4.00 to $5.00 cash upfront.
3. Total required balance becomes $1,004.50.
4. Because the balance is only $1,000.00, the exchange throws `402 Payment Required: account has 1000.0 available, needs 1004.50`.

Reserving 2% ($20.00) allows the order to fill reliably without hitting margin errors, while still deploying 98% of available capital into the trade.

---

## 3. Trade Objectives & Strategy Rules

1. **BTC Macro Anchor**:
   * `BTCUSDT` is monitored continuously for 1h/15m trend direction, momentum, and 24h performance. It is used as the macro market anchor and is not traded directly by the worker fleet.
2. **Minimum 5% Capital Profit Target**:
   * At 10x leverage, achieving a **5% return on capital** requires at minimum a **0.50% price move**:
     $$\text{Target Return} = \text{Price Move \%} \times \text{Leverage} \ge 0.5\% \times 10 = 5\%$$
   * For **LONG**: `takeProfit >= currentPrice * 1.005`
   * For **SHORT**: `takeProfit <= currentPrice * 0.995`
3. **Strict Invalidation (SL)**:
   * Stop Loss is anchored to local swing structure / support / resistance identified by the LLM.
   * Enforces Risk/Reward Ratio $(R/R) \ge 1.5$.
4. **Real-Time Exit Execution**:
   * Stop Loss and Take Profit levels are evaluated **instantly on every sub-second Binance WebSocket price tick** rather than waiting for candle closes.

---

## 4. Isolated Paper Accounts

Each symbol runs in an independent, isolated ledger on `paper_exchange`:

| Symbol | Paper Account ID | Starting Margin | Leverage | Margin Type |
| :--- | :--- | :--- | :--- | :--- |
| **ETHUSDT** | `crypto-minicpm-eth` | $1,000.00 | 10x | Isolated |
| **SOLUSDT** | `crypto-minicpm-sol` | $1,000.00 | 10x | Isolated |
| **XRPUSDT** | `crypto-minicpm-xrp` | $1,000.00 | 10x | Isolated |

---

## 5. Running the 24/7 Live Fleet

### Prerequisites
1. Ensure Ollama is running with `openbmb/minicpm5-2b:latest`:
   ```bash
   ollama run openbmb/minicpm5-2b:latest
   ```
2. Ensure the local paper exchange backend is up:
   ```bash
   cd /home/nemesis/projects/apps/paper_exchange && docker compose up -d
   ```

### Launch Command
From the `crypto-trading-agent` project directory:
```bash
npx tsx scripts/run-minicpm-fleet.ts
```

For long production runs spanning weeks with memory capping:
```bash
NODE_OPTIONS="--max-old-space-size=512" npx tsx scripts/run-minicpm-fleet.ts
```

### Dashboard View
The runner displays a continuous live terminal cockpit updated up to 4 times per second via real-time WebSocket ticks:
* System uptime & clock.
* Symbol state (`IDLE`, `ANALYZING`, `IN_POSITION`).
* Real-time mark price, entry price, position size, and uPnL.
* Total realized PnL and current account equity.
* Latest LLM rationale and SL/TP levels.
