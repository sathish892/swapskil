import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { loadEnv, openDatabase } from './config.mjs';

loadEnv();

const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const configuredName = process.env.ADMIN_NAME?.trim() || 'Sathish E';
const password = process.env.ADMIN_PASSWORD;
if (configuredEmail !== 'sathishsasha00@gmail.com') {
  console.error('Set ADMIN_EMAIL in the private .env file to the authorized administrator email.');
  process.exit(1);
}
if (!password || Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
  console.error('Set ADMIN_PASSWORD in the private .env file (at least 12 characters).');
  process.exit(1);
}

const db = openDatabase();
try {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  const passwordHash = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(configuredEmail);
  if (existing) {
    db.prepare(`UPDATE users SET name = ?, password_hash = ?, role = 'admin', status = 'active' WHERE id = ?`)
      .run(configuredName, passwordHash, existing.id);
    console.log('Administrator account secured and activated.');
  } else {
    db.prepare(`INSERT INTO users (id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'admin', 'active')`)
      .run(randomUUID(), configuredName, configuredEmail, passwordHash);
    console.log('Administrator account created.');
  }
} finally {
  db.close();
}
