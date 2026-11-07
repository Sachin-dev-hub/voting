import express from 'express';
import client from 'prom-client';
import { pool, ensureSchema } from './db.js';
import { redis, recordBuffer, closeRedis } from './redis.js';

const app = express();
app.use(express.json());

const ANIMALS = ['lion', 'tiger', 'dog', 'cat'];

const votesTotal = new client.Counter({
  name: 'votes_total',
  help: 'Total votes cast',
  labelNames: ['animal'],
});

app.get('/healthz', async (_req, res) => {
  let db = 'down';
  let rds = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'up';
  } catch {}
  try {
    await redis.ping();
    rds = 'up';
  } catch {}
  const ok = db === 'up' && rds === 'up';
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db, redis: rds });
});

app.post('/api/vote', async (req, res) => {
  const animal = req.body && req.body.animal;
  if (!ANIMALS.includes(animal)) {
    return res
      .status(400)
      .json({ error: `animal must be one of: ${ANIMALS.join(', ')}` });
  }
  try {
    await pool.query('INSERT INTO votes (animal) VALUES ($1)', [animal]);
    await recordBuffer(animal);
    votesTotal.inc({ animal });
    res.status(201).json({ ok: true, animal });
  } catch (err) {
    console.error('vote failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/results', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT animal, count(*)::int AS votes FROM votes GROUP BY animal ORDER BY animal',
    );
    const out = Object.fromEntries(ANIMALS.map((a) => [a, 0]));
    for (const row of rows) out[row.animal] = row.votes;
    res.json(out);
  } catch (err) {
    console.error('results failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

const port = process.env.PORT || 3000;

await ensureSchema();
app.listen(port, () => console.log(`backend listening on :${port}`));

async function shutdown() {
  await closeRedis();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);