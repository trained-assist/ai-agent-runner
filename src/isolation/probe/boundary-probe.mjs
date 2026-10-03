#!/usr/bin/env node
/**
 * Проба границы Agent clean room (issue #51).
 *
 * Запускается Runner'ом ПОД ИДЕНТИЧНОСТЬЮ рана (setpriv/runuser, без дополнительных групп)
 * с тем же env и cwd, что получит движок, и проверяет отрицательные свойства границы:
 * чужой ран, корень Runner'а, его credentials и общие read-only инструменты недоступны,
 * а свои HOME/tmp и разрешённые бинари — доступны. Плюс сверка, что сам движок реально
 * исполняется под той же идентичностью и что его нельзя убить из соседнего рана.
 *
 * Выход: один JSON-объект в stdout. Ноль — все проверки сошлись; 3 — граница нарушена;
 * 4 — проба не смогла выполниться (ошибка пробы, а не нарушение).
 */
// realpathSync берём из node:fs: в ESM-импорте node:path этот именованный экспорт
// недоступен, и проба падала бы на разборе модуля вместо вердикта.
import { accessSync, constants, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync as readProcStatus } from 'node:fs';

const checks = [];

function record(name, expect, target, outcome, detail) {
  checks.push({ name, expect, target, outcome, detail });
}

function deniedBy(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function tryDenied(label, expect, target, fn) {
  try {
    fn();
    record(label, expect, target, 'allowed', 'operation succeeded');
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'ERR';
    // Отсутствующая цель — не утечка: чужой ран мог уже закончиться и быть вычищен.
    // Такую проверку пропускаем, иначе уборка соседа выглядела бы нарушением границы.
    if (code === 'ENOENT') {
      record(label, expect, target, 'skipped', 'target is already gone');
      return;
    }
    record(label, expect, target, deniedBy(error) ? 'denied' : 'error', code);
  }
}

function tryAllowed(label, expect, target, fn) {
  try {
    fn();
    record(label, expect, target, 'allowed', 'operation succeeded');
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'ERR';
    record(label, expect, target, code === 'ENOENT' ? 'skipped' : 'error', code);
  }
}

function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function selfStatus() {
  const status = readProcStatus('/proc/self/status', 'utf8');
  const field = (key) => {
    const line = status.split('\n').find((entry) => entry.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : '';
  };
  const uidParts = field('Uid').split(/\s+/).map(Number);
  const gidParts = field('Gid').split(/\s+/).map(Number);
  const groups = field('Groups').split(/\s+/).filter(Boolean).map(Number);
  return { uid: uidParts[0], gid: gidParts[0], groups };
}

function main() {
  const expectedUid = Number(process.env.RUNNER_EXPECTED_UID ?? 0);
  const expectedGid = Number(process.env.RUNNER_EXPECTED_GID ?? 0);
  const roomDir = process.env.RUN_CLEAN_ROOM_DIR ?? '';
  const roomCwd = process.env.RUN_CLEAN_ROOM_CWD ?? process.cwd();
  const runnerRoot = process.env.RUNNER_ROOT ?? '';
  const credentials = readJsonEnv('RUNNER_CREDENTIAL_PATHS') ?? [];
  const siblings = readJsonEnv('RUNNER_SIBLINGS') ?? [];
  const toolPaths = readJsonEnv('RUNNER_TOOL_PATHS') ?? [];
  const enginePid = Number(process.env.RUNNER_ENGINE_PID ?? 0);

  const self = selfStatus();
  record(
    'identity.uid',
    'allowed',
    'expected run uid',
    self.uid === expectedUid ? 'allowed' : 'error',
    `uid=${self.uid} expected=${expectedUid}`,
  );
  const foreignGroups = self.groups.filter((group) => group !== self.gid);
  record(
    'identity.groups_cleared',
    'allowed',
    'no supplementary groups',
    foreignGroups.length === 0 ? 'allowed' : 'error',
    foreignGroups.length === 0 ? 'no supplementary groups' : `supplementary groups: ${foreignGroups.join(',')}`,
  );

  let cwdOk = false;
  try {
    const real = realpathSync(process.cwd());
    const base = realpathSync(roomCwd);
    cwdOk = real === base;
    record('identity.cwd', 'allowed', roomCwd, cwdOk ? 'allowed' : 'error', `cwd=${real}`);
  } catch (error) {
    record('identity.cwd', 'allowed', roomCwd, 'error', String(error && error.code ? error.code : error));
  }

  const home = process.env.HOME ?? '';
  const tmp = process.env.TMPDIR ?? '';
  tryAllowed('home.writable', 'allowed', home, () => {
    const probe = `${home}/.boundary-probe-${process.pid}`;
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true });
  });
  record(
    'home.scoped',
    'allowed',
    'HOME inside clean room',
    home.startsWith(`${roomDir}/`) ? 'allowed' : 'error',
    `HOME=${home}`,
  );
  tryAllowed('tmp.writable', 'allowed', tmp, () => {
    const probe = `${tmp}/.boundary-probe-${process.pid}`;
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true });
  });
  record(
    'tmp.scoped',
    'allowed',
    'TMPDIR inside clean room',
    tmp.startsWith(`${roomDir}/`) ? 'allowed' : 'error',
    `TMPDIR=${tmp}`,
  );

  for (const sibling of siblings) {
    const label = `sibling[${sibling.runId}]`;
    tryDenied(`${label}.cwd_denied`, 'denied', sibling.cwd, () => readdirSync(sibling.cwd));
    tryDenied(`${label}.home_denied`, 'denied', sibling.home, () => readdirSync(sibling.home));
    tryDenied(`${label}.state_denied`, 'denied', `${runnerRoot}/runs/${sibling.runId}/state.json`, () =>
      readFileSync(`${runnerRoot}/runs/${sibling.runId}/state.json`, 'utf8'),
    );
    if (sibling.pid > 0) {
      tryDenied(`${label}.kill_denied`, 'denied', `pid ${sibling.pid}`, () => process.kill(sibling.pid, 0));
    } else {
      record(`${label}.kill_denied`, 'skipped', 'no sibling pid', 'skipped', 'sibling process not running');
    }
  }

  tryDenied('runner.root_denied', 'denied', runnerRoot, () => readdirSync(runnerRoot));
  for (const path of credentials) {
    tryDenied('runner.credential_denied', 'denied', path, () => readFileSync(path, 'utf8'));
  }

  for (const toolPath of toolPaths) {
    tryDenied('tool.write_denied', 'denied', toolPath, () => {
      writeFileSync(`${toolPath}/.boundary-probe-${process.pid}`, 'x');
    });
    tryAllowed('tool.executable', 'allowed', toolPath, () => {
      accessSync(toolPath, constants.X_OK);
    });
  }

  if (enginePid > 0) {
    let engineUid = -1;
    try {
      const status = readProcStatus(`/proc/${enginePid}/status`, 'utf8');
      const line = status.split('\n').find((entry) => entry.startsWith('Uid:'));
      engineUid = line ? Number(line.slice(4).trim().split(/\s+/)[0]) : -1;
    } catch {
      engineUid = -1;
    }
    record(
      'engine.identity_match',
      'allowed',
      `pid ${enginePid}`,
      engineUid === expectedUid ? 'allowed' : 'error',
      `engine uid=${engineUid} expected=${expectedUid}`,
    );
    tryDenied('engine.kill_denied', 'denied', `pid ${enginePid}`, () => process.kill(enginePid, 0));
  } else {
    record('engine.identity_match', 'skipped', 'no engine pid', 'skipped', 'engine process not running');
  }

  const failures = checks.filter((check) => {
    if (check.outcome === 'skipped') return false;
    if (check.expect === 'denied') return check.outcome !== 'denied';
    return check.outcome !== 'allowed';
  });

  const result = {
    ok: failures.length === 0,
    uid: self.uid,
    gid: self.gid,
    groups: self.groups,
    checks,
    // причина провала — в сообщении: по логу рана должно быть видно, КАКАЯ именно
    // отрицательная проверка не сработала, а не только «граница нарушена».
    failures: failures.map((check) => `${check.name}:${check.outcome}:${check.detail}`),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = failures.length === 0 ? 0 : 3;
}

try {
  await main();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      uid: -1,
      gid: -1,
      groups: [],
      checks,
      failures: [`probe_crashed:${error && error.code ? error.code : 'ERR'}`],
    })}\n`,
  );
  process.exitCode = 4;
}
