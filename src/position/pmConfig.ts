import { config } from '../config.js';
import { DEFAULT_PM_CONFIG, type PmConfig } from './PositionManager.js';

/** Manager parameters from the environment; the cost buffer is the round-trip taker fee plus slippage the sizer already assumes. */
export function pmConfigFromEnv(): PmConfig {
  const pm = config.positionManager;
  return {
    ...DEFAULT_PM_CONFIG,
    tp1R: pm.tp1R, tp1Fraction: pm.tp1Fraction, tp2R: pm.tp2R, tp2Fraction: pm.tp2Fraction, trailAtr: pm.trailAtr,
    costBufferRate: 2 * (config.risk.takerFeeRate + config.risk.slippageBufferRate),
  };
}
