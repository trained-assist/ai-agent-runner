/**
 * Гонка 'exit' против stdio (issue: два одновременных рана → ISOLATION_IDENTITY_UNAVAILABLE).
 *
 * `exitCode` резолвится на 'exit', который приходит сразу после смерти процесса.
 * Быстрая команда на загруженном event loop умирает раньше, чем сработают 'data' на
 * stdout — считыватель видел пустой `out` и честно объявлял слот «не unix account».
 * `exitCodeAndDrain` ждёт закрытия обоих потоков, поэтому вывод не теряется.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { exitCodeAndDrain } from '../src/isolation/clean-room.js';

describe('exitCodeAndDrain: вывод быстрого процесса не теряется', () => {
  it('многострочный вывод дочитывается целиком (код 0)', async () => {
    const child = spawn('/bin/sh', ['-c', 'printf "a:b:c:d:e:f:g\\n"'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const code = await exitCodeAndDrain(child);
    expect(code).toBe(0);
    expect(out.trim()).toBe('a:b:c:d:e:f:g');
    expect(out.split(':').length).toBe(7);
  });

  it('процесс без вывода: код возвращается, а не зависание', async () => {
    const child = spawn('/usr/bin/true', [], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Оба потока обязаны быть подписаны: непрочитанный поток не закрывается,
    // а 'close' процесса ждёт закрытия обоих.
    child.stdout.resume();
    child.stderr.resume();
    const code = await exitCodeAndDrain(child);
    expect(code).toBe(0);
  });

  it('ненулевой код возвращается вместе с выводом', async () => {
    const child = spawn('/bin/sh', ['-c', 'echo boom; exit 3'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const code = await exitCodeAndDrain(child);
    expect(code).toBe(3);
    expect(out.trim()).toBe('boom');
  });

  it('stderr тоже сливается до возврата кода', async () => {
    const child = spawn('/bin/sh', ['-c', 'echo err-text >&2; exit 0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    const code = await exitCodeAndDrain(child);
    expect(code).toBe(0);
    expect(err.trim()).toBe('err-text');
  });
});
