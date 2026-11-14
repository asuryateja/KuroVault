// Password hashing with scrypt (memory-hard), per-user salt, constant-time verify.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

// Each hash needs ~32 MB for a moment. At most a few run at once, so a burst of sign-in
// requests queues up instead of exhausting the server's memory.
const MAX_PARALLEL = 3;
let running = 0;
const waiting = [];
async function slot() {
  if (running >= MAX_PARALLEL) await new Promise(resolve => waiting.push(resolve));
  running += 1;
}
function release() {
  running -= 1;
  waiting.shift()?.();
}

async function derive(password, salt, params = PARAMS) {
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      scrypt(password.normalize('NFKC'), salt, KEYLEN, params, (err, key) => (err ? reject(err) : resolve(key)));
    });
  } finally { release(); }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  // Refuse absurd stored parameters instead of burning CPU on them.
  if (!(Number(N) >= 2 ** 14 && Number(N) <= 2 ** 17 && Number(r) === 8 && Number(p) >= 1 && Number(p) <= 4)) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await derive(password, Buffer.from(saltB64, 'base64'), { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Unknown usernames are verified against this hash so response time does not reveal which accounts exist.
let dummyHash;
export async function dummyVerify(password) {
  dummyHash ??= await hashPassword(randomBytes(18).toString('base64'));
  await verifyPassword(password, dummyHash);
  return false;
}

const COMMON = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiopas', 'letmein', 'welcome', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'trustno1', 'telegram', 'telegramdrive',
  'changeme', 'kurovault', 'filora', 'stashrook', 'ravenhold', 'kurovault123', 'qwertyuiop', '12345678', '123456789', '1234567890', '11111111', 'asdfghjkl', 'zxcvbnm123', 'passw0rd', 'p@ssw0rd', 'qwerty123', '1q2w3e4r5t6y', 'abc123', 'master', 'superman', 'whatever',
]);

/** Returns a list of problems; empty means the password is acceptable. */
export function passwordProblems(password, username = '', { min = 12 } = {}) {
  const problems = [];
  if (typeof password !== 'string') return ['Password is required.'];
  if (password.length < min) problems.push(`Use at least ${min} characters.`);
  if (password.length > 256) problems.push('Use at most 256 characters.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(password)).length;
  if (password.length < 16 && classes < (min >= 12 ? 3 : 2)) problems.push(min >= 12 ? 'Mix at least three of: lowercase, uppercase, digits, symbols (or use 16+ characters).' : 'Mix letters with digits or symbols (or use 16+ characters).');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9@]/g, ''))) problems.push('This password is too common.');
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) problems.push('Do not include the username.');
  if (/^(.)\1+$/.test(password) || /(.)\1{5,}/.test(password)) problems.push('Avoid long runs of the same character.');
  return problems;
}
