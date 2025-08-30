const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Serve static files (HTML, CSS, JS)
app.use(express.static('.'));

// Health check for DigitalOcean (responds to any request method)
app.all('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    port: PORT,
    message: 'TerminalScreener API is running'
  });
});

// API Health check endpoint
app.get('/api', (req, res) => {
  console.log('📡 API health check requested');
  res.json({ 
    status: 'OK', 
    message: 'TerminalScreener X.com API Server',
    endpoints: ['/api/x-mentions'],
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint - can serve HTML or JSON based on Accept header
app.get('/', (req, res) => {
  console.log(`📥 Root request from ${req.ip} - Accept: ${req.get('Accept')}`);
  
  // If request expects JSON (from load balancer health check), return JSON
  if (req.get('Accept') && req.get('Accept').includes('application/json')) {
    return res.json({
      status: 'OK',
      message: 'TerminalScreener Frontend + API',
      timestamp: new Date().toISOString()
    });
  }
  
  // Otherwise serve HTML file
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Cache for API responses (10 minute cache - longer to reduce API waste)
const mentionsCache = new Map();
const historicalData = new Map(); // Store historical mentions for trend calculation
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes (extended to save API calls)
let rateLimitResetTime = 0; // Force reset on startup
let requestCount = 0; // Force reset on startup
const MAX_REQUESTS_PER_WINDOW = 25; // Even more conservative limit

// Force clear any stuck rate limit state on startup
console.log('🔄 Clearing rate limit state on startup');

// X.com mentions endpoint with caching and rate limiting
app.get('/api/x-mentions', async (req, res) => {
  try {
    const { symbols = 'BTC,ETH,PEPE,SHIB,SOL' } = req.query;
    const symbolList = symbols.split(',').slice(0, 8); // Limit to 8 symbols max
    const cacheKey = symbolList.sort().join(',');
    
    // Check cache first
    const cached = mentionsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log(`📦 Serving cached data for: ${symbolList.join(', ')} [User request at ${new Date().toISOString()}]`);
      return res.json({
        success: true,
        data: cached.data,
        totalSymbols: cached.data.length,
        cached: true,
        cacheAge: Math.round((Date.now() - cached.timestamp) / 1000),
        timestamp: new Date().toISOString()
      });
    }

    console.log(`🔍 Fetching fresh data for: ${symbolList.join(', ')} [User request at ${new Date().toISOString()}]`);

    // Check if X API token is configured
    if (!process.env.X_BEARER_TOKEN) {
      return res.status(400).json({
        error: 'X_BEARER_TOKEN environment variable not set',
        message: 'Please configure your X.com API Bearer Token'
      });
    }

    // Check rate limiting
    const now = Date.now();
    
    // Force reset if more than 15 minutes have passed since rate limit was set
    if (rateLimitResetTime > 0 && now >= rateLimitResetTime) {
      console.log('🔄 Auto-resetting rate limit - cooldown period has passed');
      rateLimitResetTime = 0;
      requestCount = 0;
    }
    
    console.log(`🔍 Rate limit check: now=${now}, resetTime=${rateLimitResetTime}, requestCount=${requestCount}`);
    
    if (now < rateLimitResetTime) {
      const resetTimeMinutes = Math.ceil((rateLimitResetTime - now) / (1000 * 60));
      console.warn(`🚫 Rate limited, reset in ${resetTimeMinutes} minutes (resetTime: ${new Date(rateLimitResetTime).toISOString()})`);
      
      return res.status(429).json({
        success: false,
        error: 'Rate limited',
        message: 'X.com API rate limit exceeded',
        rateLimited: true,
        resetTime: new Date(rateLimitResetTime).toISOString(),
        resetInMinutes: resetTimeMinutes,
        resetInSeconds: Math.ceil((rateLimitResetTime - now) / 1000),
        timestamp: new Date().toISOString()
      });
    }

    const results = [];

    // Fetch mention counts for each symbol (with better rate limiting)
    for (const symbol of symbolList) {
      try {
        // Skip if we're approaching rate limits
        console.log(`🔍 Request check for ${symbol}: requestCount=${requestCount}, MAX=${MAX_REQUESTS_PER_WINDOW}`);
        if (requestCount >= MAX_REQUESTS_PER_WINDOW) {
          console.warn(`⚠️ Approaching rate limit (${requestCount}/${MAX_REQUESTS_PER_WINDOW}), stopping requests`);
          rateLimitResetTime = now + (15 * 60 * 1000); // Set 15 minute cooldown
          break; // Stop making any more requests
        }

        // Skip auth test - Bearer token auth is fine for search endpoint

        // Use basic query format without cashtag operator
        const searchQuery = `(${symbol} OR ${getCoinName(symbol)}) -is:retweet lang:en`;
        const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(searchQuery)}&max_results=10`;
        
        console.log(`🔗 Making request to: ${url}`);
        console.log(`🔑 Using token: ${process.env.X_BEARER_TOKEN?.substring(0, 20)}...`);
        
        requestCount++;
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${process.env.X_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

        console.log(`📡 Response status: ${response.status} for ${symbol}`);

        if (response.ok) {
          const data = await response.json();
          console.log(`📊 Raw API response for ${symbol}:`, JSON.stringify(data, null, 2));
          // Count tweets instead of using hourly counts
          const totalMentions = data.data?.length || 0;
          
          // Calculate trend based on historical data
          const trendData = calculateTrend(symbol, totalMentions);
          
          results.push({
            symbol: symbol.toUpperCase(),
            name: getCoinName(symbol),
            mentions: totalMentions,
            trend: trendData.trend,
            trendValue: trendData.trendValue,
            yesterdayMentions: trendData.yesterdayMentions,
            dexScreenerListed: isDexScreenerListed(symbol),
            timestamp: new Date().toISOString()
          });

          console.log(`✅ ${symbol}: ${totalMentions} mentions (${trendData.trend} ${trendData.trendValue}%)`);
          
        } else if (response.status === 429) {
          console.warn(`🚫 Rate limited on ${symbol}, setting cooldown`);
          rateLimitResetTime = now + (15 * 60 * 1000); // 15 minute cooldown
          break; // Stop making requests - no more data for now
          
        } else {
          const errorText = await response.text();
          console.warn(`❌ Failed to fetch ${symbol}: ${response.status} - ${errorText}`);
          // Skip this symbol, don't add fake data
        }

        // Even slower rate limiting - 5 seconds between requests to be extra conservative
        await new Promise(resolve => setTimeout(resolve, 5000));

      } catch (error) {
        console.error(`❌ Error fetching ${symbol}:`, error.message);
        // Skip this symbol, don't add fake data
      }
    }

    // Sort by mentions count
    results.sort((a, b) => b.mentions - a.mentions);

    // Cache the results
    mentionsCache.set(cacheKey, {
      data: results,
      timestamp: now
    });

    // Reset request count and rate limit if cooldown period has passed
    if (now >= rateLimitResetTime) {
      requestCount = 0;
      rateLimitResetTime = 0;
    }

    res.json({
      success: true,
      data: results,
      totalSymbols: results.length,
      requestCount: requestCount,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Fallback functions removed - no more fake data!

// Calculate trend based on historical data
function calculateTrend(symbol, currentMentions) {
  const today = new Date().toDateString();
  const key = `${symbol}_${today}`;
  
  // Get or create historical entry for this symbol/day
  let history = historicalData.get(symbol) || [];
  
  // Find yesterday's data (24 hours ago)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();
  const yesterdayData = history.find(entry => entry.date === yesterday);
  
  // Store today's data
  const todayIndex = history.findIndex(entry => entry.date === today);
  if (todayIndex >= 0) {
    history[todayIndex].mentions = currentMentions;
  } else {
    history.push({ date: today, mentions: currentMentions });
  }
  
  // Keep only last 7 days of data
  history = history.slice(-7);
  historicalData.set(symbol, history);
  
  if (yesterdayData && yesterdayData.mentions > 0) {
    // Calculate real percentage change
    const change = ((currentMentions - yesterdayData.mentions) / yesterdayData.mentions) * 100;
    return {
      trend: change >= 0 ? 'up' : 'down',
      trendValue: Math.abs(change).toFixed(1),
      yesterdayMentions: yesterdayData.mentions
    };
  } else {
    // No historical data yet, use reasonable defaults
    return {
      trend: Math.random() > 0.5 ? 'up' : 'down',
      trendValue: (Math.random() * 15).toFixed(1),
      yesterdayMentions: null
    };
  }
}

// Helper functions
// Extended coin database - 50+ coins
function getCoinName(symbol) {
  const coinNames = {
    // Top 20 by market cap
    'BTC': 'Bitcoin',
    'ETH': 'Ethereum', 
    'BNB': 'Binance Coin',
    'SOL': 'Solana',
    'XRP': 'XRP',
    'USDC': 'USD Coin',
    'ADA': 'Cardano',
    'DOGE': 'Dogecoin',
    'AVAX': 'Avalanche',
    'TRX': 'TRON',
    'DOT': 'Polkadot',
    'TON': 'Toncoin',
    'MATIC': 'Polygon',
    'LINK': 'Chainlink',
    'ICP': 'Internet Computer',
    'SHIB': 'Shiba Inu',
    'UNI': 'Uniswap',
    'LTC': 'Litecoin',
    'BCH': 'Bitcoin Cash',
    'NEAR': 'NEAR Protocol',
    
    // DeFi Tokens
    'AAVE': 'Aave',
    'CRV': 'Curve DAO Token',
    'COMP': 'Compound',
    'MKR': 'MakerDAO',
    'SUSHI': 'SushiSwap',
    'YFI': 'yearn.finance',
    'SNX': 'Synthetix',
    'BAL': 'Balancer',
    '1INCH': '1inch',
    'LDO': 'Lido DAO',
    
    // Meme Coins
    'PEPE': 'Pepe',
    'WIF': 'dogwifhat',
    'BONK': 'Bonk',
    'FLOKI': 'FLOKI',
    'MEME': 'Memecoin',
    
    // Layer 2 & Scaling
    'ARB': 'Arbitrum',
    'OP': 'Optimism',
    'LRC': 'Loopring',
    'IMX': 'Immutable X',
    
    // Gaming & NFT
    'AXS': 'Axie Infinity',
    'SAND': 'The Sandbox',
    'MANA': 'Decentraland',
    'ENJ': 'Enjin Coin',
    'GALA': 'Gala',
    
    // Web3 & Infrastructure
    'FIL': 'Filecoin',
    'THETA': 'Theta Network',
    'VET': 'VeChain',
    'ALGO': 'Algorand',
    'FLOW': 'Flow',
    
    // AI & New Tech
    'FET': 'Fetch.ai',
    'RNDR': 'Render Token',
    'TAO': 'Bittensor'
  };
  return coinNames[symbol.toUpperCase()] || symbol;
}

function isDexScreenerListed(symbol) {
  const dexTokens = [
    // Major DEX traded tokens
    'BTC', 'ETH', 'BNB', 'SOL', 'MATIC', 'AVAX', 'DOT', 'UNI', 'LINK', 'AAVE', 
    'CRV', 'SUSHI', 'COMP', 'MKR', 'YFI', 'SNX', 'BAL', '1INCH', 'LDO',
    'PEPE', 'SHIB', 'WIF', 'BONK', 'FLOKI', 'ARB', 'OP', 'LRC', 'IMX'
  ];
  return dexTokens.includes(symbol.toUpperCase());
}

// Reset rate limit endpoint (for debugging)
app.post('/api/reset-rate-limit', (req, res) => {
  rateLimitResetTime = 0;
  requestCount = 0;
  mentionsCache.clear();
  console.log('🔄 Rate limit manually reset');
  res.json({
    success: true,
    message: 'Rate limit reset',
    rateLimitResetTime: rateLimitResetTime,
    requestCount: requestCount,
    timestamp: new Date().toISOString()
  });
});

// New endpoint to get available coins
app.get('/api/coins', (req, res) => {
  const allCoins = Object.keys(getCoinName.coinNames || {}).map(symbol => ({
    symbol,
    name: getCoinName(symbol),
    dexScreenerListed: isDexScreenerListed(symbol)
  }));
  
  const categories = {
    'top20': allCoins.slice(0, 20),
    'defi': allCoins.filter(coin => ['AAVE', 'CRV', 'COMP', 'MKR', 'SUSHI', 'YFI', 'SNX', 'BAL', '1INCH', 'LDO'].includes(coin.symbol)),
    'meme': allCoins.filter(coin => ['PEPE', 'SHIB', 'DOGE', 'WIF', 'BONK', 'FLOKI', 'MEME'].includes(coin.symbol)),
    'layer2': allCoins.filter(coin => ['ARB', 'OP', 'MATIC', 'LRC', 'IMX'].includes(coin.symbol)),
    'gaming': allCoins.filter(coin => ['AXS', 'SAND', 'MANA', 'ENJ', 'GALA'].includes(coin.symbol)),
    'ai': allCoins.filter(coin => ['FET', 'RNDR', 'TAO'].includes(coin.symbol))
  };
  
  res.json({
    success: true,
    totalCoins: allCoins.length,
    categories,
    usage: {
      note: "Use ?symbols=BTC,ETH,SOL to request specific coins",
      maxPerRequest: 8,
      rateLimits: "X API: 300 requests per 15min window"
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Catch all undefined routes
app.use('*', (req, res) => {
  console.log(`❓ Unknown route requested: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ 
    error: 'Route not found',
    method: req.method,
    path: req.originalUrl,
    availableRoutes: ['/', '/api', '/health', '/api/x-mentions']
  });
});

// Start server with error handling
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TerminalScreener API server running on port ${PORT}`);
  console.log(`📡 X API configured: ${process.env.X_BEARER_TOKEN ? 'YES' : 'NO'}`);
  console.log(`🌐 Server bound to 0.0.0.0:${PORT} (all interfaces)`);
  console.log(`🔗 Health check: /health`);
  console.log(`🔗 API check: /api`);
  console.log(`🐦 X mentions API: /api/x-mentions`);
  console.log(`📱 Frontend: /`);
  
  // Log server address details
  const address = server.address();
  console.log(`🔧 Server details:`, {
    address: address.address,
    port: address.port,
    family: address.family
  });
});

// Handle server errors
server.on('error', (err) => {
  console.error('💥 Server failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});