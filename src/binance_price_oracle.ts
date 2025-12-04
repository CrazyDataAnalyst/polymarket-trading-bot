/**
 * Binance WebSocket Price Oracle for Polymarket BTC UP/DOWN Markets
 * 
 * Connects to Binance's WebSocket API to calculate fair probabilities
 * for BTC hourly UP/DOWN markets based on real-time price data.
 * 
 * Resolution Logic (from Polymarket):
 * - Market resolves based on the 1H candle from Binance BTC/USDT
 * - UP wins if Close > Open
 * - DOWN wins if Close <= Open
 * 
 * Data source: https://www.binance.com/en/trade/BTC_USDT (1H candle)
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface PriceProbability {
    probUp: number;          // Probability (0-1) that BTC closes UP
    probDown: number;        // Probability (0-1) that BTC closes DOWN
    currentPrice: number;    // Current BTC price
    openPrice: number;       // Open price of current hourly candle
    priceChange: number;     // Current - Open (in USD)
    priceChangePercent: number; // Percentage change from open
    timeRemainingMs: number; // Milliseconds until candle close
    timeRemainingPercent: number; // Percentage of hour remaining (0-100)
    confidence: number;      // How confident we are (0-1, increases as hour progresses)
    timestamp: Date;
}

/**
 * BinancePriceOracle - Calculates fair probabilities for BTC UP/DOWN outcomes
 * 
 * The probability model uses a statistical approach:
 * 
 * 1. Current "lead" = current_price - open_price
 *    - Positive lead means currently UP
 *    - Negative lead means currently DOWN
 * 
 * 2. Time remaining affects how likely the lead can flip
 *    - More time = more uncertainty
 *    - Less time = more certainty about current state
 * 
 * 3. Volatility affects how much price can move in remaining time
 * 
 * Formula: P(UP) = Φ(lead / (σ × √time_remaining))
 * Where Φ is the standard normal CDF
 */
export class BinancePriceOracle extends EventEmitter {
    private ws: WebSocket | null = null;
    private reconnectInterval: number = 5000;
    private isRunning: boolean = false;
    
    // Current candle state
    private currentPrice: number = 0;
    private openPrice: number = 0;
    private highPrice: number = 0;
    private lowPrice: number = 0;
    private klineStartTime: number = 0;
    private klineCloseTime: number = 0;
    
    // Volatility tracking for probability model
    private priceHistory: { price: number; time: number }[] = [];
    private readonly maxHistorySize: number = 300;
    
    // Configuration
    private readonly BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
    private readonly SYMBOL = 'btcusdt';
    private readonly INTERVAL = '1h';
    
    // Model parameters
    private readonly BASE_HOURLY_VOLATILITY = 0.003; // ~0.3% base hourly volatility
    private readonly MIN_PROBABILITY = 0.01;  // Never go below 1%
    private readonly MAX_PROBABILITY = 0.99;  // Never go above 99%
    
    // Logging control
    private lastLogTime: number = 0;
    private logInterval: number = 10000; // Log every 10 seconds

    constructor() {
        super();
    }

    /**
     * Start the oracle - connects to Binance WebSocket
     */
    async start(): Promise<void> {
        this.isRunning = true;
        await this.connect();
    }

    /**
     * Stop the oracle
     */
    stop(): void {
        this.isRunning = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Connect to Binance WebSocket kline stream
     */
    private async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.isRunning) {
                reject(new Error('Oracle not running'));
                return;
            }

            const streamUrl = `${this.BINANCE_WS_URL}/${this.SYMBOL}@kline_${this.INTERVAL}`;
            console.log(`📡 Connecting to Binance: ${streamUrl}`);
            
            this.ws = new WebSocket(streamUrl);

            this.ws.on('open', () => {
                console.log('✅ Binance WebSocket connected');
                this.emit('connected');
                resolve();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.processKlineMessage(message);
                } catch (error) {
                    // Silent parse error
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ Binance WebSocket error:', error.message);
                this.emit('error', error);
            });

            this.ws.on('close', () => {
                console.log('Binance WebSocket closed');
                this.emit('disconnected');
                
                if (this.isRunning) {
                    console.log(`Reconnecting in ${this.reconnectInterval / 1000}s...`);
                    setTimeout(() => this.connect(), this.reconnectInterval);
                }
            });

            setTimeout(() => {
                if (this.ws?.readyState !== WebSocket.OPEN) {
                    reject(new Error('Connection timeout'));
                }
            }, 10000);
        });
    }

    /**
     * Process incoming kline/candlestick data from Binance
     */
    private processKlineMessage(message: any): void {
        if (message.e !== 'kline') return;

        const kline = message.k;
        const now = Date.now();
        
        // Update state from Binance data
        this.currentPrice = parseFloat(kline.c);  // Current close = current price
        this.openPrice = parseFloat(kline.o);     // Open price of this hourly candle
        this.highPrice = parseFloat(kline.h);
        this.lowPrice = parseFloat(kline.l);
        this.klineStartTime = kline.t;            // Candle start timestamp
        this.klineCloseTime = kline.T;            // Candle close timestamp

        // Track price history for volatility calculation
        this.priceHistory.push({ price: this.currentPrice, time: now });
        if (this.priceHistory.length > this.maxHistorySize) {
            this.priceHistory.shift();
        }

        // Calculate and emit probability
        const probability = this.calculateProbability();
        this.emit('probability', probability);

        // Periodic logging
        if (now - this.lastLogTime >= this.logInterval) {
            const timeLeftMin = (probability.timeRemainingMs / 60000).toFixed(1);
            const changeStr = probability.priceChange >= 0 ? '+' : '';
            
            console.log(
                `[Oracle] BTC: $${this.currentPrice.toFixed(2)} | ` +
                `Open: $${this.openPrice.toFixed(2)} | ` +
                `${changeStr}${probability.priceChangePercent.toFixed(3)}% | ` +
                `UP: ${(probability.probUp * 100).toFixed(1)}% | ` +
                `DOWN: ${(probability.probDown * 100).toFixed(1)}% | ` +
                `Time: ${timeLeftMin}min`
            );
            
            this.lastLogTime = now;
        }
    }

    /**
     * Calculate realized volatility from recent price history
     */
    private calculateRecentVolatility(): number {
        if (this.priceHistory.length < 10) {
            return this.BASE_HOURLY_VOLATILITY;
        }

        const returns: number[] = [];
        for (let i = 1; i < this.priceHistory.length; i++) {
            const ret = Math.log(this.priceHistory[i].price / this.priceHistory[i - 1].price);
            returns.push(ret);
        }

        if (returns.length < 5) {
            return this.BASE_HOURLY_VOLATILITY;
        }

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);

        const timespanMs = this.priceHistory[this.priceHistory.length - 1].time - this.priceHistory[0].time;
        const updatesPerHour = (3600000 / timespanMs) * this.priceHistory.length;
        const hourlyVolatility = stdDev * Math.sqrt(updatesPerHour);

        return Math.max(hourlyVolatility, this.BASE_HOURLY_VOLATILITY);
    }

    /**
     * Calculate fair probability of UP vs DOWN outcome
     */
    calculateProbability(): PriceProbability {
        const now = Date.now();
        
        // Calculate time metrics
        const hourDuration = this.klineCloseTime - this.klineStartTime;
        const timeRemainingMs = Math.max(0, this.klineCloseTime - now);
        const timeRemainingPercent = (timeRemainingMs / hourDuration) * 100;
        const timeFractionRemaining = timeRemainingMs / hourDuration;
        
        // Price change metrics
        const priceChange = this.currentPrice - this.openPrice;
        const priceChangePercent = this.openPrice > 0 
            ? (priceChange / this.openPrice) * 100 
            : 0;

        let probUp: number;
        
        if (this.openPrice === 0 || this.currentPrice === 0) {
            probUp = 0.5;
        } else if (timeRemainingMs <= 0) {
            probUp = priceChange > 0 ? 1 : 0;
        } else if (timeFractionRemaining > 0.98) {
            probUp = 0.5;
        } else {
            const volatility = this.calculateRecentVolatility();
            const expectedRemainingStdDev = volatility * this.openPrice * Math.sqrt(timeFractionRemaining);
            
            if (expectedRemainingStdDev < 0.01) {
                probUp = priceChange > 0 ? this.MAX_PROBABILITY : this.MIN_PROBABILITY;
            } else {
                const z = priceChange / expectedRemainingStdDev;
                probUp = this.normalCDF(z);
            }
        }

        probUp = Math.max(this.MIN_PROBABILITY, Math.min(this.MAX_PROBABILITY, probUp));
        const probDown = 1 - probUp;

        const timeConfidence = 1 - timeFractionRemaining;
        const priceConfidence = Math.min(Math.abs(priceChangePercent) / 0.5, 1);
        const confidence = Math.max(timeConfidence, priceConfidence);

        return {
            probUp,
            probDown,
            currentPrice: this.currentPrice,
            openPrice: this.openPrice,
            priceChange,
            priceChangePercent,
            timeRemainingMs,
            timeRemainingPercent,
            confidence,
            timestamp: new Date()
        };
    }

    /**
     * Standard normal CDF approximation
     */
    private normalCDF(x: number): number {
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;

        const sign = x < 0 ? -1 : 1;
        x = Math.abs(x);

        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

        return 0.5 * (1.0 + sign * (2 * y - 1));
    }

    getCurrentProbability(): PriceProbability {
        return this.calculateProbability();
    }

    getPrices(): { current: number; open: number; high: number; low: number } {
        return {
            current: this.currentPrice,
            open: this.openPrice,
            high: this.highPrice,
            low: this.lowPrice
        };
    }

    hasData(): boolean {
        return this.currentPrice > 0 && this.openPrice > 0;
    }

    getTimeRemaining(): number {
        return Math.max(0, this.klineCloseTime - Date.now());
    }
}

// Standalone test
if (require.main === module) {
    (async () => {
        console.log('='.repeat(60));
        console.log('🔮 Binance Price Oracle - Test Mode');
        console.log('='.repeat(60));
        console.log('');
        console.log('Resolution rules:');
        console.log('  - UP wins if hourly Close > Open');
        console.log('  - DOWN wins if hourly Close <= Open');
        console.log('');
        console.log('='.repeat(60));

        const oracle = new BinancePriceOracle();

        oracle.on('error', (error: Error) => {
            console.error('Oracle error:', error);
        });

        try {
            await oracle.start();
            console.log('\n📊 Oracle started. Press Ctrl+C to stop.\n');

            process.on('SIGINT', () => {
                console.log('\n\nStopping oracle...');
                oracle.stop();
                process.exit(0);
            });

        } catch (error) {
            console.error('Failed to start oracle:', error);
            process.exit(1);
        }
    })();
}

export default BinancePriceOracle;