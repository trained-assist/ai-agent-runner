let meta = {};
try {
  meta = JSON.parse(process.argv[2] ?? '{}');
} catch {
  meta = {};
}

const bindings = Array.isArray(meta.bindings) ? meta.bindings : [];
const binding = bindings[0];
if (!binding || typeof binding.ref !== 'string' || !binding.ref.startsWith('env:')) {
  console.error('cred engine requires a binding with ref "env:<NAME>"');
  process.exit(1);
}
const envName = binding.ref.slice(4);
const value = process.env[envName];
const scope = typeof binding.scope === 'string' ? binding.scope : 'unknown';
const gateway = process.env.E2E_GATEWAY_URL;

if (!value) {
  console.log(`E2E_CRED ref=${binding.ref} scope=${scope} verdict=MISSING`);
  process.exit(1);
}
if (!gateway) {
  console.log(`E2E_CRED ref=${binding.ref} scope=${scope} verdict=NO_GATEWAY`);
  process.exit(1);
}

async function call(action) {
  try {
    const response = await fetch(`${gateway}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-e2e-credential': value },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    return response.status;
  } catch (err) {
    return `ERR:${err && err.name ? err.name : 'unknown'}`;
  }
}

const readStatus = await call('read');
const writeStatus = await call('write');
console.log(`E2E_CRED ref=${binding.ref} scope=${scope} read=${readStatus} write=${writeStatus}`);
console.log(`E2E_ENV keys=${Object.keys(process.env).sort().join(',')}`);
process.exit(0);
