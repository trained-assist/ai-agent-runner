import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

let prompt = {};
try {
  const meta = JSON.parse(process.argv[2] ?? '{}');
  prompt = typeof meta.inlinePrompt === 'string' ? JSON.parse(meta.inlinePrompt) : {};
} catch {
  prompt = {};
}

const ref = typeof prompt.ref === 'string' && prompt.ref.length > 0 ? prompt.ref : 'report.txt';
if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) {
  console.error(`artifact ref must be a bare file name: ${ref}`);
  process.exit(1);
}

const lines = Array.isArray(prompt.lines) && prompt.lines.length > 0 ? prompt.lines : ['e2e artifact'];
const body = `${lines.join('\n')}\n`;

chmodSync(process.cwd(), 0o700);
writeFileSync(ref, body, { mode: 0o600 });
chmodSync(ref, 0o600);

const bytes = readFileSync(ref);
const sha = createHash('sha256').update(bytes).digest('hex');
console.log(`E2E_ARTIFACT ref=${ref} sha256=${sha} bytes=${bytes.length} mode=600`);
console.log(`E2E_ENV keys=${Object.keys(process.env).sort().join(',')}`);
process.exit(0);
