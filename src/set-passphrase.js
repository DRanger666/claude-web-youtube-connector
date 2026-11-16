// Asks for the sign-in passphrase and saves its hash:
//   npm run set-passphrase
import { createInterface } from 'node:readline/promises';
import { STATE_DIR, savePassphrase } from './auth.js';

const prompt = createInterface({ input: process.stdin, output: process.stdout });
const passphrase = await prompt.question('New passphrase (at least 12 characters): ');
prompt.close();
if (passphrase.length < 12) {
  console.error(`That is ${passphrase.length} characters; nothing was saved`);
  process.exit(1);
}
savePassphrase(passphrase);
console.log(`Passphrase saved in ${STATE_DIR}`);
