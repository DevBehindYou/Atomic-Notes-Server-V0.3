import { z } from 'zod';

/** Preserve the pre-Zod-4 timestamp contract without changing serialized values. */
export function legacyDateTimeSchema({ offset = false }: { offset?: boolean } = {}) {
  const zone = offset ? '(?:Z|[+-]\\d{2}:?\\d{2})' : 'Z';
  const shape = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?${zone}$`);
  return z.string().refine(value => {
    const matched = shape.exec(value);
    if (!matched) return false;
    const year = Number(matched[1]), month = Number(matched[2]), day = Number(matched[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
  }, 'Invalid datetime');
}
