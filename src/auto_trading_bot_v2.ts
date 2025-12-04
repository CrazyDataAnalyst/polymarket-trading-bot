/**
 * Auto Trading Bot with Binance Price Oracle
 * 
 * Replaces the third-party WebSocket with Binance-based probability calculator.
 */

import { ApiKeyCreds, ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { BalanceChecker, BalanceInfo } from './balance_checker';
import BinancePriceOracle, { PriceProbability } from './binance_price_oracle';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface PriceData {
    UP: number;
    DOWN: number;
}

interface Trade {
    tokenType: string;
    tokenId: string;
    buyOrderId: string;
    takeProfitOrderId: string;
    stopLossOrderId: string;
    buyPrice: number;
    targetPrice: number;
    stopPrice: number;
    amount: number;
    timestamp: Date;
    status: string;
}

interface TradeOpportunity {
    tokenType: string;
    tokenId: string;
    oraclePrice: number;
    polymarketPrice: number;
    difference: number;
}

class AutoTradingBotV2 {
    private wallet: Wallet;
    private client: ClobClient;
    private balanceChecker: BalanceChecker;
    private priceOracle: BinancePriceOracle;
    
    private tokenIdUp: string | null = null;
    private tokenIdDown: string | null = null;
    
    private oraclePrices: PriceData = { UP: 0, DOWN: 0 };
    private polymarketPrices: Map<string, number> = new Map();
    
    private activeTrades: Trade[] = [];
    private lastTradeTime: number = 0;
    private lastBalanceCheck: number = 0;
    private balanceCheckInterval: number = 60000;
    
    private priceThreshold: number;
    private stopLossAmount: number;
    private takeProfitAmount: number;
    private tradeCooldown: number;
    private tradeAmount: number;
    private minimumBalance: number;
    
    private polymarketWs: WebSocket | null = null;
    private isRunning: boolean = false;

    constructor() {
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey || privateKey.length < 64) {
            console.error('❌ PRIVATE_KEY not found or invalid');
            throw new Error('PRIVATE_KEY not found in .env');
        }
        this.wallet = new Wallet(privateKey);
        this.client = new ClobClient(
            process.env.CLOB_API_URL || 'https://clob.polymarket.com',
            137,
            this.wallet
        );
        this.balanceChecker = new BalanceChecker();
        this.priceOracle = new BinancePriceOracle();

        this.priceThreshold = parseFloat(process.env.PRICE_DIFFERENCE_THRESHOLD || '0.015');
        this.stopLossAmount = parseFloat(process.env.STOP_LOSS_AMOUNT || '0.005');
        this.takeProfitAmount = parseFloat(process.env.TAKE_PROFIT_AMOUNT || '0.01');
        this.tradeCooldown = parseInt(process.env.TRADE_COOLDOWN || '30') * 1000;
        this.tradeAmount = parseFloat(process.env.DEFAULT_TRADE_AMOUNT || '5.0');
        this.minimumBalance = parseFloat(process.env.MINIMUM_BALANCE || '500.0');
    }

    async start() {
        console.log('='.repeat(60));
        console.log('🤖 Auto Trading Bot v2 - Binance Oracle Edition');
        console.log('='.repeat(60));
		
		console.log('🔑 Authenticating with Polymarket CLOB...');
		
		try {
            const creds = await this.client.createOrDeriveApiKey();
            
            this.client = new ClobClient(
                process.env.CLOB_API_URL || 'https://clob.polymarket.com',
                137,
                this.wallet,
                creds
            );
            console.log('✅ API Credentials Derived & Active');
        } catch (error: any) {
            console.error('❌ Authentication Failed:', error.message);
            throw error;
        }
		
        console.log(`Wallet: ${this.wallet.address}`);
        console.log(`Threshold: $${this.priceThreshold.toFixed(4)}`);
        console.log(`Take Profit: +$${this.takeProfitAmount.toFixed(4)}`);
        console.log(`Stop Loss: -$${this.stopLossAmount.toFixed(4)}`);
        console.log(`Trade Amount: $${this.tradeAmount.toFixed(2)}`);
        console.log(`Cooldown: ${this.tradeCooldown / 1000}s`);
        console.log('='.repeat(60));

        console.log('\n💰 Checking wallet balances...');
        const balances = await this.checkAndDisplayBalances();
        
        const check = this.balanceChecker.checkSufficientBalance(balances, this.minimumBalance, 0.05);
        console.log('\n📊 Balance Check:');
        check.warnings.forEach(w => console.log(`  ${w}`));
        
        if (!check.sufficient) {
            console.log('\n❌ Insufficient funds!');
            throw new Error('Insufficient balance');
        }
        
        console.log('\n✅ Balances sufficient!');
        
        await this.initializeMarket();
        
        console.log('\n📡 Starting Binance Price Oracle...');
        this.setupOracleHandlers();
        await this.priceOracle.start();
        
        console.log('\n📡 Connecting to Polymarket...');
        await this.connectPolymarketWebSocket();
        
        console.log('⏳ Waiting for initial price data...');
        await this.waitForInitialData();
        
        this.isRunning = true;
        this.startMonitoring();
        this.startTradingLoop();
        
        console.log('\n✅ Bot started successfully!');
        console.log('🚀 Monitoring for arbitrage opportunities...\n');
    }

    private setupOracleHandlers(): void {
        this.priceOracle.on('probability', (prob: PriceProbability) => {
            this.oraclePrices.UP = prob.probUp;
            this.oraclePrices.DOWN = prob.probDown;
        });

        this.priceOracle.on('error', (error: Error) => {
            console.error('Oracle error:', error.message);
        });

        this.priceOracle.on('disconnected', () => {
            console.log('⚠️  Oracle disconnected, reconnecting...');
        });
    }

    private async waitForInitialData(): Promise<void> {
        const maxWait = 15000; // Reduced since we're polling
        let waited = 0;

        while (waited < maxWait) {
            const hasOracleData = this.priceOracle.hasData();
            const hasMarketData = this.polymarketPrices.size > 0;
            
            // Log what we have
            if (waited % 3000 === 0 && waited > 0) {
                console.log(`  Waiting... Oracle: ${hasOracleData ? '✓' : '✗'}, Market prices: ${this.polymarketPrices.size}`);
                if (hasMarketData) {
                    for (const [tokenId, price] of this.polymarketPrices) {
                        console.log(`    ${tokenId.substring(0, 16)}... = ${price.toFixed(4)}`);
                    }
                }
            }

            if (hasOracleData && hasMarketData) {
                console.log('✅ Initial data received');
                return;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            waited += 1000;
        }
        console.log('⚠️  Timeout waiting for data, starting anyway...');
    }

    private async checkAndDisplayBalances(): Promise<BalanceInfo> {
        const balances = await this.balanceChecker.checkBalances(this.wallet);
        this.balanceChecker.displayBalances(balances);
        return balances;
    }

    private async initializeMarket() {
        console.log('\n🔍 Finding current Bitcoin market...');
        
        const now = new Date();
        const etOptions: Intl.DateTimeFormatOptions = { 
            timeZone: 'America/New_York',
            hour: 'numeric',
            hour12: true,
            month: 'long',
            day: 'numeric'
        };
        
        const etFormatter = new Intl.DateTimeFormat('en-US', etOptions);
        const parts = etFormatter.formatToParts(now);
        
        let month = '', day = '', hour = '', dayPeriod = '';
        for (const part of parts) {
            if (part.type === 'month') month = part.value.toLowerCase();
            if (part.type === 'day') day = part.value;
            if (part.type === 'hour') hour = part.value;
            if (part.type === 'dayPeriod') dayPeriod = part.value.toLowerCase();
        }
        
        const slug = `bitcoin-up-or-down-${month}-${day}-${hour}${dayPeriod}-et`;
        console.log(`Searching for market: ${slug}`);
        
        try {
            const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
            const data: any = await response.json();
            
            let market = null;
            if (Array.isArray(data) && data.length > 0) {
                market = data[0];
            } else if (data.data?.length > 0) {
                market = data.data[0];
            }
            
            if (!market) {
                console.log('Market not found by slug, searching active markets...');
                const activeResponse = await fetch('https://gamma-api.polymarket.com/markets?active=true&limit=50&closed=false');
                const activeData: any = await activeResponse.json();
                const markets = Array.isArray(activeData) ? activeData : (activeData.data || []);
                
                market = markets.find((m: any) => {
                    const q = (m.question || '').toLowerCase();
                    return (q.includes('bitcoin') || q.includes('btc')) && 
                           (q.includes('up') || q.includes('down'));
                });
                
                if (!market) throw new Error('No active Bitcoin UP/DOWN market found');
            }

            let tokenIds = market.clobTokenIds || [];
            if (typeof tokenIds === 'string') tokenIds = JSON.parse(tokenIds);
            
            let outcomes = market.outcomes || [];
            if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);

            if (tokenIds.length < 2) throw new Error('Market must have at least 2 tokens');

            let upIndex = outcomes.findIndex((o: string) => 
                o.toLowerCase().includes('up') || o.toLowerCase().includes('yes')
            );
            let downIndex = outcomes.findIndex((o: string) => 
                o.toLowerCase().includes('down') || o.toLowerCase().includes('no')
            );

            if (upIndex === -1) upIndex = 0;
            if (downIndex === -1) downIndex = 1;

            this.tokenIdUp = String(tokenIds[upIndex]);
            this.tokenIdDown = String(tokenIds[downIndex]);

            console.log(`✅ Market found: ${market.question}`);
            console.log(`   UP Token: ${this.tokenIdUp.substring(0, 20)}...`);
            console.log(`   DOWN Token: ${this.tokenIdDown.substring(0, 20)}...`);

        } catch (error: any) {
            console.error('Error finding market:', error.message);
            throw error;
        }
    }

    private async connectPolymarketWebSocket(): Promise<void> {
        return new Promise((resolve) => {
            const url = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
            
            const connect = () => {
                console.log(`📡 Connecting to: ${url}`);
                
                this.polymarketWs = new WebSocket(url, {
                   // ping_interval=5, ping_timeout=None
                });

                this.polymarketWs.on('open', () => {
                    console.log('✅ Polymarket WebSocket connected');
                    
                    // Use the same format as Python script: {"assets_ids": [...]}
                    const subscribeMessage = {
                        assets_ids: [this.tokenIdUp, this.tokenIdDown]
                    };
                    
                    console.log('📤 Sending subscription:', JSON.stringify(subscribeMessage));
                    this.polymarketWs?.send(JSON.stringify(subscribeMessage));
                    resolve();
                });

                this.polymarketWs.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.processPolymarketMessage(message);
                    } catch (error) {
                        // Log parse errors for debugging
                        console.log('⚠️ Failed to parse message:', data.toString().substring(0, 100));
                    }
                });

                this.polymarketWs.on('error', (error) => {
                    console.error('❌ Polymarket WebSocket error:', error.message);
                });

                this.polymarketWs.on('close', (code, reason) => {
                    console.log(`🔌 Polymarket WebSocket closed: ${code} - ${reason}`);
                    if (this.isRunning) {
                        console.log('Reconnecting in 5 seconds...');
                        setTimeout(connect, 5000);
                    }
                });
            };
            
            connect();
        });
    }

    private processPolymarketMessage(data: any): void {
        // Log first few messages to debug format
        if (!this._messageCount) this._messageCount = 0;
        this._messageCount++;
        
        // Format 1: Array of order book snapshots (first message after subscribe)
        if (Array.isArray(data)) {
            data.forEach((item: any) => {
                const assetId = item.asset_id;
                if (assetId && (assetId === this.tokenIdUp || assetId === this.tokenIdDown)) {
                    if (item.bids?.length > 0 && item.asks?.length > 0) {
                        const bid = parseFloat(item.bids[0].price);
                        const ask = parseFloat(item.asks[0].price);
                        const mid = (bid + ask) / 2;
                        this.polymarketPrices.set(assetId, mid);
                        
                        const tokenName = assetId === this.tokenIdUp ? 'UP' : 'DOWN';
                        console.log(`💰 Initial ${tokenName}: Bid=${bid.toFixed(2)}, Ask=${ask.toFixed(2)}, Mid=${mid.toFixed(2)}`);
                    }
                }
            });
            return;
        }

        // Format 2: price_changes updates (most common, real-time updates)
        if (data.price_changes && Array.isArray(data.price_changes)) {
            for (const change of data.price_changes) {
                const assetId = change.asset_id;
                if (assetId && (assetId === this.tokenIdUp || assetId === this.tokenIdDown)) {
                    const bid = parseFloat(change.best_bid || '0');
                    const ask = parseFloat(change.best_ask || '0');
                    
                    if (bid > 0 && ask > 0) {
                        const mid = (bid + ask) / 2;
                        this.polymarketPrices.set(assetId, mid);
                    }
                }
            }
            return;
        }

        // Format 3: Direct asset_id with bids/asks
        if (data.asset_id && (data.asset_id === this.tokenIdUp || data.asset_id === this.tokenIdDown)) {
            if (data.bids?.length > 0 && data.asks?.length > 0) {
                const bid = parseFloat(data.bids[0].price);
                const ask = parseFloat(data.asks[0].price);
                const mid = (bid + ask) / 2;
                this.polymarketPrices.set(data.asset_id, mid);
            }
        }
    }

    private _messageCount: number = 0;

    private startTradingLoop(): void {
        const loop = async () => {
            if (!this.isRunning) return;
            
            try {
                const opportunity = await this.checkTradeOpportunity();
                if (opportunity) {
                    await this.executeTrade(opportunity);
                }
            } catch (error: any) {
                console.error('Trading loop error:', error.message);
            }
            
            setTimeout(loop, 1000);
        };
        loop();
    }

    private startMonitoring(): void {
        let lastLogTime = 0;
        
        setInterval(async () => {
            if (!this.isRunning) return;

            const now = Date.now();
            
            if (now - this.lastBalanceCheck >= this.balanceCheckInterval) {
                const balances = await this.balanceChecker.checkBalances(this.wallet);
                const check = this.balanceChecker.checkSufficientBalance(balances, this.minimumBalance, 0.02);
                if (!check.sufficient) {
                    console.log('⚠️  Low balance warning!');
                }
                this.lastBalanceCheck = now;
            }
            
            if (now - lastLogTime >= 30000) {
                const prob = this.priceOracle.getCurrentProbability();
                const upMarket = this.polymarketPrices.get(this.tokenIdUp!) || 0;
                const downMarket = this.polymarketPrices.get(this.tokenIdDown!) || 0;
                
                console.log(
                    `[Status] BTC: $${prob.currentPrice.toFixed(0)} | ` +
                    `Open: $${prob.openPrice.toFixed(0)} | ` +
                    `Oracle: UP=${(prob.probUp * 100).toFixed(1)}% DOWN=${(prob.probDown * 100).toFixed(1)}% | ` +
                    `Market: UP=${(upMarket * 100).toFixed(1)}% DOWN=${(downMarket * 100).toFixed(1)}% | ` +
                    `Time: ${(prob.timeRemainingMs / 60000).toFixed(1)}min`
                );
                lastLogTime = now;
            }
        }, 1000);
    }

    private async checkTradeOpportunity(): Promise<TradeOpportunity | null> {
        const cooldownRemaining = this.tradeCooldown - (Date.now() - this.lastTradeTime);
        if (cooldownRemaining > 0) return null;
        if (!this.priceOracle.hasData()) return null;

        const balances = await this.balanceChecker.checkBalances(this.wallet);
        if (balances.usdc < this.minimumBalance) return null;

        for (const tokenType of ['UP', 'DOWN']) {
            const oraclePrice = this.oraclePrices[tokenType as keyof PriceData];
            const tokenId = tokenType === 'UP' ? this.tokenIdUp : this.tokenIdDown;
            if (!tokenId) continue;

            const marketPrice = this.polymarketPrices.get(tokenId) || 0;
            const diff = oraclePrice - marketPrice;

            if (diff >= this.priceThreshold && oraclePrice > 0 && marketPrice > 0) {
                return { tokenType, tokenId, oraclePrice, polymarketPrice: marketPrice, difference: diff };
            }
        }
        return null;
    }

    private async executeTrade(opportunity: TradeOpportunity): Promise<void> {
        console.log('\n' + '='.repeat(60));
        console.log('🎯 TRADE OPPORTUNITY!');
        console.log(`Token: ${opportunity.tokenType}`);
        console.log(`Oracle: ${(opportunity.oraclePrice * 100).toFixed(2)}% | Market: ${(opportunity.polymarketPrice * 100).toFixed(2)}%`);
        console.log(`Edge: ${(opportunity.difference * 100).toFixed(2)}%`);
        console.log('='.repeat(60));

        this.lastTradeTime = Date.now();

        try {
            // Round prices to 2 decimal places (tick size = 0.01)
            const roundPrice = (p: number) => Math.round(p * 100) / 100;
            
            const buyPrice = roundPrice(opportunity.polymarketPrice * 1.01); // Add 1% buffer
            const shares = Math.floor(this.tradeAmount / buyPrice); // Whole shares only

            if (shares < 1) {
                console.log('❌ Trade amount too small for at least 1 share');
                return;
            }

            console.log(`📊 Placing buy order: ${shares} shares @ $${buyPrice.toFixed(2)}`);

            const buyResult = await this.client.createAndPostOrder(
                { tokenID: opportunity.tokenId, price: buyPrice, size: shares, side: Side.BUY },
                { tickSize: '0.01', negRisk: false },
                OrderType.GTC
            );
            console.log(`✅ Buy order: ${buyResult.orderID}`);

            await new Promise(resolve => setTimeout(resolve, 2000));

            const takeProfitPrice = roundPrice(Math.min(opportunity.polymarketPrice + this.takeProfitAmount, 0.99));
            const stopLossPrice = roundPrice(Math.max(opportunity.polymarketPrice - this.stopLossAmount, 0.01));

            console.log(`📊 Placing TP @ $${takeProfitPrice.toFixed(2)}, SL @ $${stopLossPrice.toFixed(2)}`);

            const tpResult = await this.client.createAndPostOrder(
                { tokenID: opportunity.tokenId, price: takeProfitPrice, size: shares, side: Side.SELL },
                { tickSize: '0.01', negRisk: false },
                OrderType.GTC
            );

            const slResult = await this.client.createAndPostOrder(
                { tokenID: opportunity.tokenId, price: stopLossPrice, size: shares, side: Side.SELL },
                { tickSize: '0.01', negRisk: false },
                OrderType.GTC
            );

            console.log(`✅ Take Profit: ${tpResult.orderID} @ $${takeProfitPrice.toFixed(2)}`);
            console.log(`✅ Stop Loss: ${slResult.orderID} @ $${stopLossPrice.toFixed(2)}`);

            this.activeTrades.push({
                tokenType: opportunity.tokenType,
                tokenId: opportunity.tokenId,
                buyOrderId: buyResult.orderID,
                takeProfitOrderId: tpResult.orderID,
                stopLossOrderId: slResult.orderID,
                buyPrice,
                targetPrice: takeProfitPrice,
                stopPrice: stopLossPrice,
                amount: this.tradeAmount,
                timestamp: new Date(),
                status: 'active'
            });

            console.log(`✅ Trade complete! Next trade in ${this.tradeCooldown / 1000}s\n`);

        } catch (error: any) {
            console.error('❌ Trade failed:', error.message);
        }
    }

    stop(): void {
        this.isRunning = false;
        this.priceOracle.stop();
        this.polymarketWs?.close();
        console.log('Bot stopped');
    }
}

async function main() {
    const bot = new AutoTradingBotV2();
    
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        bot.stop();
        process.exit(0);
    });

    await bot.start();
}

main().catch(console.error);

export { AutoTradingBotV2 };