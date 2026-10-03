import { describe, expect, it } from 'vitest';
import { faultRegistry, parseFaultPoints } from '../src/faults/env.js';
import { FAULT_POINTS } from '../src/faults/registry.js';

/**
 * #52: формат управляемого сбоя задаётся переменной окружения, и ошибка в нём обязана
 * валить старт. Иначе проба lifecycle отчиталась бы «прошла», ни разу не упав там, где
 * должна была, и доказательство уборки после сбоя оказалось бы пустым.
 */
describe('управляемые точки сбоя из env (AGENT_API_FAULTS, #52)', () => {
  it('пустая переменная = отказов нет', () => {
    expect(parseFaultPoints(undefined)).toEqual([]);
    expect(parseFaultPoints('')).toEqual([]);
    expect(parseFaultPoints('  , ')).toEqual([]);
    expect(faultRegistry([])).toBeUndefined();
  });

  it('разбирает список точек, запятые и пробелы', () => {
    expect(parseFaultPoints('cleanup,export')).toEqual(['cleanup', 'export']);
    expect(parseFaultPoints('cleanup export')).toEqual(['cleanup', 'export']);
    expect(parseFaultPoints(`cleanup:${'2'}`)).toEqual(['cleanup:2']);
    for (const point of FAULT_POINTS) expect(parseFaultPoints(point)).toEqual([point]);
  });

  it('неизвестная точка валит разбор с перечислением допустимых', () => {
    expect(() => parseFaultPoints('cleanup,sweep_everything')).toThrow(/unknown fault point "sweep_everything"/);
    expect(() => parseFaultPoints('nope')).toThrow(new RegExp(FAULT_POINTS.join(', ')));
  });

  it('кривое число срабатываний валит разбор, а не превращается в ноль', () => {
    expect(() => parseFaultPoints('cleanup:0')).toThrow(/count must be a positive integer/);
    expect(() => parseFaultPoints('cleanup:-1')).toThrow(/count must be a positive integer/);
    expect(() => parseFaultPoints('cleanup:many')).toThrow(/count must be a positive integer/);
    expect(() => parseFaultPoints('cleanup:1:2')).toThrow(/expected "point" or "point:count"/);
  });

  it('одна запись без count срабатывает один раз, с count — указанное число раз', () => {
    const once = faultRegistry(parseFaultPoints('cleanup'));
    expect(once?.has('cleanup')).toBe(true);
    expect(once?.take('cleanup')?.kind).toBe('throw');
    expect(once?.has('cleanup')).toBe(false);
    expect(once?.take('cleanup')).toBeNull();

    const thrice = faultRegistry(parseFaultPoints('export:3'));
    for (let attempt = 0; attempt < 3; attempt += 1) expect(thrice?.take('export')?.kind).toBe('throw');
    expect(thrice?.has('export')).toBe(false);
    expect(thrice?.take('export')).toBeNull();
  });
});
