/**
 * Детект возможностей хоста для настоящей OS-границы рана (issue #51).
 *
 * Граница — привилегированная операция: без root нельзя создать слот, раздать ACL и
 * переключить идентичность. Обычный CI-раннер таких прав не имеет, и проба границы там
 * не может ни пройти, ни честно упасть. Поэтому хост описывается явно, а вызывающий
 * решает: пропустить проверку (непривилегированный CI) или прогнать её (песочная VM).
 *
 * Ничего не создаётся и не меняется: только чтение. Единственное исключение — создание
 * слотов, и оно вынесено в пробы, а не сюда.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveLauncher } from './launcher.js';
import type { IsolationPolicy } from './contract.js';

export interface HostSlot {
  slotId: string;
  uid: number;
  gid: number;
}

export interface HostIsolationCapabilities {
  platform: string;
  /** UID текущего процесса; null на платформах без getuid. */
  uid: number | null;
  root: boolean;
  /** Переключатель идентичности на хосте; null, если его нет. */
  launcher: 'setpriv' | 'runuser' | null;
  /** setfacl обязателен: каталог рана лежит под сервисным dataDir. */
  setfacl: boolean;
  /** Слоты, которые на хосте разрешаются в passwd. */
  slots: HostSlot[];
  /** Слоты из конфигурации, которых на хосте нет. */
  missingSlots: string[];
  /** Хост пригоден для настоящей границы рана. */
  enforced: boolean;
  /** Почему не пригоден: пусто, когда `enforced`. */
  reasons: string[];
}

function commandPath(name: string): string | null {
  const pathEnv = process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // ищем дальше
    }
  }
  return null;
}

function passwdEntry(name: string): { uid: number; gid: number } | null {
  const getent = commandPath('getent') ?? '/usr/bin/getent';
  if (!existsSync(getent)) return null;
  const result = spawnSync(getent, ['passwd', name], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const fields = (result.stdout ?? '').trim().split(':');
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid };
}

/**
 * Что этот хост умеет для границы рана. Ничего не создаёт: только читает passwd и PATH.
 */
export function detectHostIsolationCapabilities(policy: Pick<IsolationPolicy, 'slots'>): HostIsolationCapabilities {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const launcher = resolveLauncher();
  const setfacl = commandPath('setfacl') !== null;
  const slots: HostSlot[] = [];
  const missingSlots: string[] = [];
  for (const slotId of policy.slots) {
    const entry = passwdEntry(slotId);
    if (entry) slots.push({ slotId, ...entry });
    else missingSlots.push(slotId);
  }
  const reasons: string[] = [];
  if (process.platform !== 'linux') reasons.push(`platform is ${process.platform}, boundary needs linux`);
  if (uid !== 0) reasons.push(`uid ${uid ?? 'unknown'} is not 0: no useradd/chown/setfacl/setpriv`);
  if (!launcher) reasons.push('no identity launcher (setpriv/runuser) on PATH');
  if (!setfacl) reasons.push('no setfacl: a run directory under the service dataDir cannot be granted per-slot traverse access');
  if (missingSlots.length > 0) reasons.push(`slots missing on this host: ${missingSlots.join(',')}`);
  return {
    platform: process.platform,
    uid,
    root: uid === 0,
    launcher: launcher?.kind ?? null,
    setfacl,
    slots,
    missingSlots,
    enforced: reasons.length === 0,
    reasons,
  };
}

/**
 * Причина пропуска проверки границы на этом хосте; null, когда проверку надо прогнать.
 * Формулировка честная: «не смогли доказать» отличается от «доказали и упали».
 */
export function hostCapabilitySkipReason(capabilities: HostIsolationCapabilities): string | null {
  if (capabilities.enforced) return null;
  return `host cannot enforce a per-run unix boundary: ${capabilities.reasons.join('; ')}`;
}