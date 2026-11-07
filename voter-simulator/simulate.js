// Random-vote traffic generator: posts one random animal vote every N ms.
const ANIMALS = ['lion', 'tiger', 'dog', 'cat'];
const VOTE_URL = process.env.VOTE_URL || 'http://backend:3000/api/vote';
const INTERVAL_MS = Number(process.env.VOTE_INTERVAL_MS || 2000);

function pick() {
  return ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
}

async function vote() {
  const animal = pick();
  try {
    const res = await fetch(VOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ animal }),
    });
    console.log(new Date().toISOString(), `vote=${animal} -> ${res.status}`);
  } catch (err) {
    console.error(new Date().toISOString(), 'vote failed:', err.message);
  }
}

console.log(
  `simulator: 1 random vote every ${INTERVAL_MS}ms -> ${VOTE_URL} (${ANIMALS.join(', ')})`,
);
vote();
setInterval(vote, INTERVAL_MS);