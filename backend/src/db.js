import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://vote:vote@db:5432/voting',
});

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id         BIGSERIAL PRIMARY KEY,
      animal     TEXT NOT NULL CHECK (animal IN ('lion','tiger','dog','cat')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}