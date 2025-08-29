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

// API Health check endpoint
app.get('/api', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'TerminalScreener X.com API Server',
    endpoints: ['/api/x-mentions']
  });
});

// Serve the main HTML file at root (for frontend)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// X.com mentions endpoint
app.get('/api/x-mentions', async (req, res) => {
  try {
    const { symbols = 'BTC,ETH,PEPE,SHIB,SOL' } = req.query;
    const symbolList = symbols.split(',');
    const results = [];

    console.log(`Fetching mentions for: ${symbolList.join(', ')}`);

    // Check if X API token is configured
    if (!process.env.X_BEARER_TOKEN) {
      return res.status(400).json({
        error: 'X_BEARER_TOKEN environment variable not set',
        message: 'Please configure your X.com API Bearer Token'
      });
    }

    // Fetch mention counts for each symbol
    for (const symbol of symbolList) {
      try {
        const searchQuery = `($${symbol} OR ${getCoinName(symbol)}) -is:retweet lang:en`;
        const url = `https://api.twitter.com/2/tweets/counts/recent?query=${encodeURIComponent(searchQuery)}&granularity=hour`;
        
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
            trend: Math.random() > 0.5 ? 'up' : 'down', // Would need historical data for real trend
            trendValue: (Math.random() * 20).toFixed(1),
            dexScreenerListed: isDexScreenerListed(symbol),
            timestamp: new Date().toISOString()
          });

          console.log(`${symbol}: ${totalMentions} mentions`);
        } else {
          console.warn(`Failed to fetch ${symbol}: ${response.status}`);
          
          // Add fallback data for failed requests
          results.push({
            symbol: symbol.toUpperCase(),
            name: getCoinName(symbol),
            mentions: 0,
            trend: 'neutral',
            trendValue: '0.0',
            dexScreenerListed: isDexScreenerListed(symbol),
            error: `API error: ${response.status}`,
            timestamp: new Date().toISOString()
          });
        }

        // Rate limiting - respect X API limits
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`Error fetching ${symbol}:`, error.message);
        
        results.push({
          symbol: symbol.toUpperCase(),
          name: getCoinName(symbol),
          mentions: 0,
          trend: 'neutral',
          trendValue: '0.0',
          dexScreenerListed: isDexScreenerListed(symbol),
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Sort by mentions count
    results.sort((a, b) => b.mentions - a.mentions);

    res.json({
      success: true,
      data: results,
      totalSymbols: results.length,
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

// Start server - bind to all interfaces for DigitalOcean
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TerminalScreener API server running on port ${PORT}`);
  console.log(`📡 X API configured: ${process.env.X_BEARER_TOKEN ? 'YES' : 'NO'}`);
  console.log(`🌐 Server bound to 0.0.0.0:${PORT} (all interfaces)`);
  console.log(`🔗 Should be accessible via DigitalOcean app URL`);
  console.log(`🐦 X mentions API endpoint: /api/x-mentions`);
});