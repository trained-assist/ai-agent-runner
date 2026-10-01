let prompt = {};
try {
  const meta = JSON.parse(process.argv[2] ?? '{}');
  prompt = typeof meta.inlinePrompt === 'string' ? JSON.parse(meta.inlinePrompt) : {};
} catch {
  prompt = {};
}

const sleepMs = Number.isFinite(prompt.sleepMs) ? Number(prompt.sleepMs) : 1200;
console.log('fake-slow: start');
await new Promise((resolve) => setTimeout(resolve, sleepMs));
console.log('fake-slow: done');
process.exit(0);
