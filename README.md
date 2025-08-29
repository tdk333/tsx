# TerminalScreener X.com API

This is a Node.js web service that provides X.com mention data for cryptocurrency tokens.

## Deployment

- **Type**: Web Service (NOT Static Site)
- **Build Command**: `npm install`
- **Run Command**: `npm start`
- **Port**: 8080
- **Environment Variables**: 
  - `X_BEARER_TOKEN` (your X.com API token)
  - `PORT=8080`

## Endpoints

- `/` - Frontend HTML interface
- `/api` - API health check
- `/api/x-mentions` - Get X.com mentions for crypto tokens