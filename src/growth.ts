// Weight-for-age and height-for-age z-scores of a child, as the CDC recommends for the United States: the WHO growth standards
// under 24 months, the CDC 2000 growth charts from 2 to 20 years. Methods and references: docs/clinical-methods.md.
// config/growth-reference.json holds the published L, M, S parameters: WHO by day of age (0 to 731), CDC by half month (23.5 to 240).
import { readFileSync } from 'node:fs';

type Row = [number, number, number, number, number, number]; // weight L, M, S; height (length) L, M, S
type Ref = { cdc: { ages: number[]; boys: Row[]; girls: Row[] }; who: { boys: Row[]; girls: Row[] } };
export type GrowthMeasure = 'weight' | 'height'; // kg; cm
export type GrowthZ = { z: number; reference: 'WHO' | 'CDC 2000' };

let ref: Ref | undefined;
const table = (): Ref => (ref ??= JSON.parse(readFileSync(new URL('../config/growth-reference.json', import.meta.url), 'utf8')) as Ref);
const DAYS_PER_MONTH = 30.4375;
const lmsZ = (x: number, l: number, m: number, s: number): number => (Math.abs(l) < 0.01 ? Math.log(x / m) / s : ((x / m) ** l - 1) / (l * s));
const lmsValue = (z: number, l: number, m: number, s: number): number => (Math.abs(l) < 0.01 ? m * Math.exp(s * z) : m * (1 + l * s * z) ** (1 / l));

// The z-score at an age in days. Under 24 months: WHO, the table row of that day; a weight z beyond 3 (or -3) is measured in
// units of the distance between the 2nd and 3rd standard deviations, as WHO specifies. From 24 months: CDC 2000, its parameters
// interpolated between the half-month ages. No reference past 240 months, for a value that is not positive, or before birth.
export function growthZAtAge(measure: GrowthMeasure, sex: 'male' | 'female', ageDays: number, value: number): GrowthZ | undefined {
  if (!(value > 0) || !(ageDays >= 0)) return undefined;
  const t = table(), o = measure === 'weight' ? 0 : 3;
  if (ageDays < 24 * DAYS_PER_MONTH) {
    const row = (sex === 'male' ? t.who.boys : t.who.girls)[Math.round(ageDays)];
    if (!row) return undefined;
    const [l, m, s] = [row[o], row[o + 1], row[o + 2]];
    let z = lmsZ(value, l, m, s);
    if (measure === 'weight' && z > 3) { const sd3 = lmsValue(3, l, m, s); z = 3 + (value - sd3) / (sd3 - lmsValue(2, l, m, s)); }
    if (measure === 'weight' && z < -3) { const sd3 = lmsValue(-3, l, m, s); z = -3 + (value - sd3) / (lmsValue(-2, l, m, s) - sd3); }
    return { z, reference: 'WHO' };
  }
  const months = ageDays / DAYS_PER_MONTH, ages = t.cdc.ages, rows = sex === 'male' ? t.cdc.boys : t.cdc.girls;
  if (months > ages[ages.length - 1]) return undefined;
  let i = 0;
  while (i < ages.length - 2 && ages[i + 1] <= months) i++;
  const f = Math.max(0, Math.min(1, (months - ages[i]) / (ages[i + 1] - ages[i])));
  const at = (k: number) => rows[i][o + k] + f * (rows[i + 1][o + k] - rows[i][o + k]);
  return { z: lmsZ(value, at(0), at(1), at(2)), reference: 'CDC 2000' };
}

// The same from dates as written (YYYY-MM-DD, or the first ten characters of a date and time): age in whole days.
export function growthZ(measure: GrowthMeasure, sex: string | undefined, birthDate: string | undefined, date: string, value: number): GrowthZ | undefined {
  if ((sex !== 'male' && sex !== 'female') || !birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate) || !/^\d{4}-\d{2}-\d{2}/.test(date)) return undefined;
  const day = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return growthZAtAge(measure, sex, (day(date) - day(birthDate)) / 86400000, value);
}
