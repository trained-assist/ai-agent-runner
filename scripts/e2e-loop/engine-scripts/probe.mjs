import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function parseMeta() {
  try {
    const meta = JSON.parse(process.argv[2] ?? '{}');
    const targets = typeof meta.inlinePrompt === 'string' ? JSON.parse(meta.inlinePrompt) : {};
    return { targets, meta };
  } catch {
    return { targets: {}, meta: {} };
  }
}

function logProbe(name, target, verdict, detail) {
  console.log(`E2E_PROBE name=${name} target=${target} verdict=${verdict} detail=${detail}`);
}

function probeFs(name, path) {
  if (!path) {
    logProbe(name, '-', 'SKIPPED', 'no-target');
    return;
  }
  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      const entries = readdirSync(path);
      logProbe(name, path, 'LEAKED', `dir-listing:${entries.length}`);
      return;
    }
    const data = readFileSync(path);
    logProbe(name, path, 'LEAKED', `bytes:${data.length}`);
  } catch (err) {
    const code = err && err.code ? err.code : String(err && err.message);
    if (code === 'ENOENT') logProbe(name, path, 'ABSENT', 'ENOENT');
    else if (code === 'EACCES' || code === 'EPERM') logProbe(name, path, 'DENIED', code);
    else logProbe(name, path, 'DENIED', `code=${code}`);
  }
}

function probeSudo() {
  const candidates = ['/usr/bin/sudo', '/bin/sudo', '/usr/local/bin/sudo'];
  for (const binary of candidates) {
    const result = spawnSync(binary, ['-n', 'true'], { encoding: 'utf8', timeout: 4000, env: {} });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.error) {
      logProbe('sudo', binary, 'DENIED', `spawn=${result.error.code}`);
      return;
    }
    if (result.status === 0) logProbe('sudo', binary, 'LEAKED', 'exit=0');
    else logProbe('sudo', binary, 'DENIED', `exit=${result.status}`);
    return;
  }
  logProbe('sudo', 'none', 'DENIED', 'NO_SUDO_BINARY');
}

async function probeMetadata(url) {
  if (!url) {
    logProbe('metadata', '-', 'SKIPPED', 'no-target');
    return;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      const body = await response.text().catch(() => '');
      logProbe('metadata', url, 'LEAKED', `http=${response.status} bytes=${body.length}`);
    } else {
      logProbe('metadata', url, 'DENIED', `http=${response.status}`);
    }
  } catch (err) {
    const cause = err && err.cause && err.cause.code;
    logProbe('metadata', url, 'DENIED', cause ? `net=${cause}` : `net=${err && err.name}`);
  }
}

const { targets } = parseMeta();
probeFs('foreign_profile', targets.foreignProfile);
probeSudo();
await probeMetadata(targets.metadataUrl);
probeFs('secrets_env', targets.secretsEnv);
console.log(`E2E_ENV keys=${Object.keys(process.env).sort().join(',')}`);
process.exit(0);
