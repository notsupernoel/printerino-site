// The coins on the page, in a starting market-cap order (the live order is recomputed from CoinGecko market caps
// every minute). name: the display name. coingecko: CoinGecko id (primary feed). hyperliquid / backpack / coinbase /
// binance / bigone: backup feed symbols, where listed (QNT, which Hyperliquid and Backpack do not list, uses Coinbase and
// Binance; so does RAY, whose Backpack market is too thin to price it; QTC trades on BigONE alone among the exchanges the
// site reads). Chart sources are in history.js.
export const COINS = [
  { symbol: 'BTC', name: 'Bitcoin', coingecko: 'bitcoin', hyperliquid: 'BTC' },
  { symbol: 'ETH', name: 'Ethereum', coingecko: 'ethereum', hyperliquid: 'ETH' },
  { symbol: 'XRP', name: 'XRP', coingecko: 'ripple', hyperliquid: 'XRP' },
  { symbol: 'SOL', name: 'Solana', coingecko: 'solana', hyperliquid: 'SOL' },
  { symbol: 'ZEC', name: 'Zcash', coingecko: 'zcash', hyperliquid: 'ZEC' },
  { symbol: 'HYPE', name: 'Hyperliquid', coingecko: 'hyperliquid', hyperliquid: 'HYPE' },
  { symbol: 'XMR', name: 'Monero', coingecko: 'monero', hyperliquid: 'XMR' },
  { symbol: 'GRAM', name: 'Gram', coingecko: 'the-open-network', hyperliquid: 'GRAM' },
  { symbol: 'AVAX', name: 'Avalanche', coingecko: 'avalanche-2', hyperliquid: 'AVAX' },
  { symbol: 'SUI', name: 'Sui', coingecko: 'sui', hyperliquid: 'SUI' },
  { symbol: 'UNI', name: 'Uniswap', coingecko: 'uniswap', hyperliquid: 'UNI' },
  { symbol: 'NEAR', name: 'NEAR Protocol', coingecko: 'near', hyperliquid: 'NEAR' },
  { symbol: 'ENA', name: 'Ethena', coingecko: 'ethena', hyperliquid: 'ENA' },
  { symbol: 'PUMP', name: 'Pump.fun', coingecko: 'pump-fun', hyperliquid: 'PUMP' },
  { symbol: 'VVV', name: 'Venice', coingecko: 'venice-token', hyperliquid: 'VVV' },
  { symbol: 'LIT', name: 'Lighter', coingecko: 'lighter', hyperliquid: 'LIT' },
  { symbol: 'ONDO', name: 'Ondo', coingecko: 'ondo-finance', hyperliquid: 'ONDO' },
  { symbol: 'JUP', name: 'Jupiter', coingecko: 'jupiter-exchange-solana', hyperliquid: 'JUP' },
  { symbol: 'ZRO', name: 'LayerZero', coingecko: 'layerzero', hyperliquid: 'ZRO' },
  { symbol: 'RAY', name: 'Raydium', coingecko: 'raydium', coinbase: 'RAY-USD', binance: 'RAYUSDT' },
  { symbol: 'BP', name: 'Backpack', coingecko: 'backpack', backpack: 'BP_USDC' },
  { symbol: 'MET', name: 'Meteora', coingecko: 'meteora', hyperliquid: 'MET' },
  { symbol: 'BNB', name: 'BNB', coingecko: 'binancecoin', hyperliquid: 'BNB', backpack: 'BNB_USDC' },
  { symbol: 'MON', name: 'Monad', coingecko: 'monad', hyperliquid: 'MON', backpack: 'MON_USDC' },
  { symbol: 'TAO', name: 'Bittensor', coingecko: 'bittensor', hyperliquid: 'TAO' },
  { symbol: 'QNT', name: 'Quant', coingecko: 'quant-network', coinbase: 'QNT-USD', binance: 'QNTUSDT' },
  { symbol: 'STRK', name: 'Starknet', coingecko: 'starknet', hyperliquid: 'STRK' },
  { symbol: 'QTC', name: 'Quantus', coingecko: 'quantus', bigone: 'QTC-USDT' },
];
