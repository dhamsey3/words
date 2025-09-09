import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
const { default: app } = await import('../app.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'afriwrite.db');

function createUser() {
  const db = new Database(dbPath);
  const id = uuidv4();
  const email = `user_${uuidv4()}@test.com`;
  const password = 'password123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run(id, email, hash, 'Test', 'READER');
  db.close();
  return { email, password };
}

async function attemptLogin(next) {
  const { email, password } = createUser();
  const server = app.listen();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/login?next=${encodeURIComponent(next)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ email, password }),
    redirect: 'manual'
  });

  server.close();
  return res;
}

test('redirects to provided next when valid', async () => {
  const res = await attemptLogin('/dashboard');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/dashboard');
});

test('falls back to root for invalid next values', async () => {
  const invalids = ['http://example.com', '/foo//bar', '//evil'];
  for (const next of invalids) {
    const res = await attemptLogin(next);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/');
  }
});
