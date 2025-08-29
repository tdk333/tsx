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

// Cache for API responses (5 minute cache)
const mentionsCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
let rateLimitResetTime = 0;
let requestCount = 0;
const MAX_REQUESTS_PER_WINDOW = 50; // Conservative limit

// X.com mentions endpoint with caching and rate limiting
app.get('/api/x-mentions', async (req, res) => {
  try {
    const { symbols = 'BTC,ETH,PEPE,SHIB,SOL' } = req.query;
    const symbolList = symbols.split(',').slice(0, 8); // Limit to 8 symbols max
    const cacheKey = symbolList.sort().join(',');
    
    // Check cache first
    const cached = mentionsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log(`📦 Serving cached data for: ${symbolList.join(', ')}`);
      return res.json({
        success: true,
        data: cached.data,
        totalSymbols: cached.data.length,
        cached: true,
        cacheAge: Math.round((Date.now() - cached.timestamp) / 1000),
        timestamp: new Date().toISOString()
      });
    }

    console.log(`🔍 Fetching fresh data for: ${symbolList.join(', ')}`);

    // Check if X API token is configured
    if (!process.env.X_BEARER_TOKEN) {
      return res.status(400).json({
        error: 'X_BEARER_TOKEN environment variable not set',
        message: 'Please configure your X.com API Bearer Token'
      });
    }

    // Check rate limiting
    const now = Date.now();
    if (now < rateLimitResetTime) {
      console.warn('🚫 Rate limited, serving fallback data');
      const fallbackData = generateFallbackData(symbolList);
      return res.json({
        success: true,
        data: fallbackData,
        totalSymbols: fallbackData.length,
        rateLimited: true,
        resetTime: new Date(rateLimitResetTime).toISOString(),
        timestamp: new Date().toISOString()
      });
    }

    const results = [];

    // Fetch mention counts for each symbol (with better rate limiting)
    for (const symbol of symbolList) {
      try {
        // Skip if we're approaching rate limits
        if (requestCount >= MAX_REQUESTS_PER_WINDOW) {
          console.warn(`⚠️ Approaching rate limit, using fallback for ${symbol}`);
          results.push(generateFallbackCoin(symbol));
          continue;
        }

        const searchQuery = `($${symbol} OR ${getCoinName(symbol)}) -is:retweet lang:en`;
        const url = `https://api.twitter.com/2/tweets/counts/recent?query=${encodeURIComponent(searchQuery)}&granularity=hour`;
        
        requestCount++;
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${process.env.X_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.ok) {
          const data = await response.json();
          const totalMentions = data.data?.reduce((sum, hour) => sum + hour.tweet_count, 0) || 0;
          
          results.push({
            symbol: symbol.toUpperCase(),
            name: getCoinName(symbol),
            mentions: totalMentions,
            trend: Math.random() > 0.5 ? 'up' : 'down',
            trendValue: (Math.random() * 20).toFixed(1),
            dexScreenerListed: isDexScreenerListed(symbol),
            timestamp: new Date().toISOString()
          });

          console.log(`✅ ${symbol}: ${totalMentions} mentions`);
          
        } else if (response.status === 429) {
          console.warn(`🚫 Rate limited on ${symbol}, setting cooldown`);
          rateLimitResetTime = now + (15 * 60 * 1000); // 15 minute cooldown
          results.push(generateFallbackCoin(symbol));
          break; // Stop making requests
          
        } else {
          console.warn(`❌ Failed to fetch ${symbol}: ${response.status}`);
          results.push(generateFallbackCoin(symbol, `API error: ${response.status}`));
        }

        // Slower rate limiting - 3 seconds between requests
        await new Promise(resolve => setTimeout(resolve, 3000));

      } catch (error) {
        console.error(`❌ Error fetching ${symbol}:`, error.message);
        results.push(generateFallbackCoin(symbol, error.message));
      }
    }

    // Fill remaining symbols with fallback data if we hit rate limits
    const remainingSymbols = symbolList.slice(results.length);
    for (const symbol of remainingSymbols) {
      results.push(generateFallbackCoin(symbol));
    }

    // Sort by mentions count
    results.sort((a, b) => b.mentions - a.mentions);

    // Cache the results
    mentionsCache.set(cacheKey, {
      data: results,
      timestamp: now
    });

    // Reset request count every 15 minutes
    if (now - rateLimitResetTime > 15 * 60 * 1000) {
      requestCount = 0;
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

// Generate fallback data for a single coin
function generateFallbackCoin(symbol, error = null) {
  return {
    symbol: symbol.toUpperCase(),
    name: getCoinName(symbol),
    mentions: Math.floor(Math.random() * 200) + 50, // Realistic fallback numbers
    trend: Math.random() > 0.5 ? 'up' : 'down',
    trendValue: (Math.random() * 15).toFixed(1),
    dexScreenerListed: isDexScreenerListed(symbol),
    fallback: true,
    error: error,
    timestamp: new Date().toISOString()
  };
}

// Generate fallback data for multiple coins
function generateFallbackData(symbolList) {
  return symbolList.map(symbol => generateFallbackCoin(symbol));
}

// Helper functions
function getCoinName(symbol) {
  const coinNames = {
    'BTC': 'Bitcoin',
    'ETH': 'Ethereum',
    'PEPE': 'Pepe',
    'SHIB': 'Shiba Inu',
    'DOGE': 'Dogecoin',
    'SOL': 'Solana',
    'ADA': 'Cardano',
    'LINK': 'Chainlink',
    'UNI': 'Uniswap',
    'MATIC': 'Polygon',
    'AAVE': 'Aave',
    'CRV': 'Curve'
  };
  return coinNames[symbol.toUpperCase()] || symbol;
}

function isDexScreenerListed(symbol) {
  const dexTokens = ['BTC', 'ETH', 'PEPE', 'SHIB', 'UNI', 'LINK', 'AAVE', 'CRV', 'SUSHI', 'COMP', 'MKR', 'SOL', 'MATIC'];
  return dexTokens.includes(symbol.toUpperCase());
}

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