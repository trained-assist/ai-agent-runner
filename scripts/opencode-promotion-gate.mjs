#!/usr/bin/env node
/**
 * Гейт промоушена: проверить кандидата сборки форка ДО того, как он куда-то попадёт.
 *
 * Порядок намеренно такой: сначала провенанс (скачали, сверили sha256 архива,
 * сверили, что бинарь запускается и его sha256 записан), потом поведение
 * (адаптер раннера признаёт бинарь исполнимым), и только потом — прогоны e2e.
 * Красный шаг останавливает всё: промоушен не делается, в отчёте видно, какой
 * именно шаг не прошёл.
 *
 * Живые прогоны (`--live`) требуют доступа к модели и включаются отдельно; без
 * них гейт всё равно проверяет провенанс и контракт адаптера — то есть отвечает
 * на вопрос «можно ли это вообще рассматривать», а не «понравилось ли нам».
 *
 * Ничего не устанавливает и не подменяет: гейт только читает и запускает.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FORK_REPO = 'gpt-mem/opencode-mem';
const LINUX_ARCHIVE = 'opencode-linux-x64.tar.gz';
const SHA256 = /^[0-9a-f]{64}$/;

export function parseGateArgs(argv) {
  const args = { live: false, suites: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--live') { args.live = true; continue; }
    if (flag === '--skip-e2e') { args.skipE2e = true; continue; }
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'suite') args.suites.push(value);
    else args[key] = value;
  }  for (const required of ['candidateTag', 'candidateSource', 'archiveSha256', 'workDir']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!SHA256.test(args.archiveSha256)) throw new Error('--archive-sha256 must be 64 lowercase hex characters');
  return args;
}

export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Сверяет скачанный архив с ожидаемым дайджестом и распаковывает бинарь.
 * Скачивание делает workflow (`gh release download`/`curl`) — как в
 * `vm-worker-release.yml`: гейт не ходит в сеть, он проверяет то, что принесли.
 */
export function extractCandidateBinary(archivePath, workDir, expectedArchiveSha256) {
  const actual = sha256OfFile(archivePath);
  if (actual !== expectedArchiveSha256) {
    throw new Error(`Candidate archive sha256 mismatch: expected=${expectedArchiveSha256} actual=${actual}`);
  }
  const outDir = join(workDir, 'candidate');
  mkdirSync(outDir, { recursive: true });
  execFileSync('tar', ['-xzf', archivePath, '-C', outDir], { stdio: 'pipe' });
  const binary = join(outDir, 'opencode');
  if (!existsSync(binary)) throw new Error(`Candidate archive does not contain an opencode binary at its root`);
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * Идентичность бинаря. `--version` — единственный способ узнать, что внутри:
 * сборки форка печатают либо `opencode v0.0.0-fork-at-<sha>` (сборка из исходников,
 * SHA вшит через OPENCODE_VERSION), либо `opencode v0.0.0-<slug>-<ts>` (релиз).
 *
 * Архив релиза — это Linux x64, поэтому на хосте без Linux бинарь не запустится.
 * Тогда шаг не «красный», а «здесь не выполнимо»: гейт решает, можно ли
 * продвигать, и решать это на хосте, который не может запустить кандидата,
 * нельзя. sha256 при этом считается на любом хосте — это байты файла.
 */
export function readCandidateIdentity(binaryPath) {
  const binarySha256 = sha256OfFile(binaryPath);
  const isElf = readFileSync(binaryPath).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  if (isElf && process.platform !== 'linux') {
    return {
      version: null,
      raw: null,
      embeddedSourceCommit: null,
      binarySha256,
      executableHere: false,
      reason: `candidate binary is a Linux ELF and cannot run on ${process.platform}; the promotion gate must run on Linux`,
    };
  }
  let raw;
  try {
    raw = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (error) {
    throw new Error(`Candidate binary does not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = raw.split('\n')[0]?.replace(/^opencode\s+v?/, '').trim() ?? '';
  if (!version) throw new Error('Candidate binary reported an empty version');
  const embedded = /fork-at-([0-9a-f]{7,40})/.exec(raw)?.[1] ?? null;
  return { version, raw, embeddedSourceCommit: embedded, binarySha256, executableHere: true, reason: null };
}

/** Прогон e2e раннера с подменённым OPENCODE_BIN. Возвращает результат, не бросает. */
export function runGateStep({ label, command, args, cwd, env }) {
  try {
    const output = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 30 * 60_000 });
    return { label, status: 'pass', output: output.slice(-4000) };
  } catch (error) {
    const e = error;
    const detail = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join('\n').trim().slice(-4000);
    return { label, status: 'fail', output: detail };
  }
}

const invokedDirectly = process.argv[1]?.endsWith('opencode-promotion-gate.mjs');
if (invokedDirectly) {
  try {
    const args = parseGateArgs(process.argv.slice(2));
    mkdirSync(args.workDir, { recursive: true });
    const steps = [];
    const archivePath = args.archivePath ?? join(args.workDir, LINUX_ARCHIVE);
    const binaryPath = args.binaryPath ?? extractCandidateBinary(archivePath, args.workDir, args.archiveSha256);
    const identity = readCandidateIdentity(binaryPath);
    steps.push({
      label: 'candidate_identity',
      status: identity.executableHere ? 'pass' : 'skip',
      output: JSON.stringify(identity),
    });
    if (!identity.executableHere) {
      steps.push({ label: 'candidate_source_matches_version', status: 'skip', output: identity.reason });
    } else if (identity.embeddedSourceCommit && !args.candidateSource.startsWith(identity.embeddedSourceCommit)) {
      steps.push({ label: 'candidate_source_matches_version', status: 'fail', output: `binary embeds ${identity.embeddedSourceCommit}, release pins ${args.candidateSource}` });
    } else {
      steps.push({ label: 'candidate_source_matches_version', status: identity.embeddedSourceCommit ? 'pass' : 'skip', output: identity.embeddedSourceCommit ? 'version string carries the source commit' : 'release build does not embed a source commit' });
    }
    if (!args.skipE2e) {
      steps.push(runGateStep({
        label: 'runner_e2e',
        command: 'npx',
        args: ['vitest', 'run', ...args.suites],
        cwd: args.repoRoot ?? process.cwd(),
        env: { OPENCODE_BIN: binaryPath },
      }));
    }
    const failed = steps.filter((step) => step.status === 'fail');
    const cannotVerify = !identity.executableHere;
    const outcome = failed.length > 0 ? 'hold' : cannotVerify ? 'cannot-verify' : 'promote';
    const decision = {
      schemaVersion: 1,
      candidate: { tag: args.candidateTag, sourceCommit: args.candidateSource, archiveSha256: args.archiveSha256, ...identity },
      binaryPath,
      steps,
      outcome,
      reason: failed.length > 0
        ? `Gate steps failed: ${failed.map((step) => step.label).join(', ')}`
        : cannotVerify
          ? identity.reason
          : 'All promotion gate steps passed',
    };
    const out = join(args.workDir, 'promotion-decision.json');
    writeFileSync(out, `${JSON.stringify(decision, null, 2)}\n`);
    for (const step of steps) process.stdout.write(`[${step.status}] ${step.label}\n${step.output}\n`);
    process.stdout.write(`outcome=${decision.outcome} reason=${decision.reason}\ndecision=${out}\n`);
    process.exit(outcome === 'promote' ? 0 : outcome === 'hold' ? 1 : 2);
  } catch (error) {
    process.stderr.write(`promotion gate did not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
