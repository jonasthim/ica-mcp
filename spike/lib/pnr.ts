/** Normalise a Swedish personnummer to 12 digits (YYYYMMDDNNNN) as ims expects. */
export function normalizePersonnummer(input: string, now: Date = new Date()): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 12) return digits;
  if (digits.length !== 10) throw new Error('personnummer must be 10 or 12 digits');
  const yy = Number(digits.slice(0, 2));
  const mm = digits.slice(2, 4);
  const dd = digits.slice(4, 6);
  const thisYear = now.getUTCFullYear();
  const candidate20 = new Date(`20${digits.slice(0, 2)}-${mm}-${dd}T00:00:00Z`);
  const century = candidate20.getTime() <= now.getTime() && 2000 + yy <= thisYear ? '20' : '19';
  return `${century}${digits}`;
}
