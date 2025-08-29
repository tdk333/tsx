app.get('/api/x-mentions', async (req, res) => {
    const response = await fetch('https://api.twitter.com/2/tweets/counts/recent', {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
    });
    res.json(await response.json());
  });
