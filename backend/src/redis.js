import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  maxRetriesPerRequest: 1,
});

// Best-effort buffer write: never fails the vote if Redis is down.
export async function recordBuffer(animal) {
  try {
    await redis.lpush('votes:buffer', animal);
    await redis.expire('votes:buffer', 3600);
  } catch (err) {
    console.warn('redis buffer write failed:', err.message);
  }
}

export function closeRedis() {
  return redis.quit();
}