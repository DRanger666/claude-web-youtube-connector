// Sets the sign-in passphrase from standard input, so it never appears in a
// command line or the shell history:
//   read -rs p && printf %s "$p" | npm run --silent set-passphrase; unset p
import { readFileSync } from 'node:fs';
import { STATE_DIR, savePassphrase } from './auth.js';

const passphrase = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (passphrase.length < 12) {
  console.error('Use a passphrase of at least 12 characters');
  process.exit(1);
}
savePassphrase(passphrase);
console.log(`Passphrase saved in ${STATE_DIR}`);
