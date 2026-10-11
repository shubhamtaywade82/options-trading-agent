import 'dotenv/config';
import { BinanceService } from '../src/binance/client.js';
const b = new BinanceService();
await b.initVenue();
const m = await b.getMarketOverview(['BTCUSDT']);
const d = m.marketDataV2?.['BTCUSDT']?.derivatives;
console.log(JSON.stringify(d, null, 2));
