#!/usr/bin/env node
// Creates an account, or sets a new password for an existing one.
//
//   node server/tools/create-user.js <username> <password>
//   node server/tools/create-user.js <username> <password> --reset
//
// In Docker:  docker compose exec app node server/tools/create-user.js <username> <password>

const config = require('../src/config');
const { Accounts } = require('../src/accounts');
const { Database } = require('../src/db');

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const [username, password] = args.filter((a) => a !== '--reset');

if (!username || !password) {
  console.error('Usage: node server/tools/create-user.js <username> <password> [--reset]');
  process.exit(1);
}

(async () => {
  const db = new Database(config.databaseUrl);
  try {
    await db.connect({ attempts: 3 });
    await db.migrate();
    const accounts = new Accounts(db, config);
    if (reset) {
      const user = await accounts.resetPassword(username, password);
      console.log(`Password updated for ${user.username}. Their existing logins were signed out.`);
    } else {
      const user = await accounts.create(username, password);
      console.log(`Created account ${user.username} (id ${user.id}).`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (error.status === 409) console.error('Add --reset to set a new password for the existing account instead.');
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
