import { z } from 'zod';
const failureSchema = z.object({ ids: z.array(z.string().uuid()).max(50)
  .refine((ids) => new Set(ids).size === ids.length) }).strict();
export function fixtureFailureIds(body: unknown): Set<string> {
  const parsed = failureSchema.safeParse(body);
  if (!parsed.success) throw new Error('fixture_invalid_failure_ids');
  return new Set(parsed.data.ids);
}

const readFaultSchema = z.object({ noteId: z.string().uuid(),
  mode: z.enum(['none', 'missing', 'corrupt', 'mismatch']) }).strict();
export function fixtureReadFault(body: unknown) {
  const parsed = readFaultSchema.safeParse(body);
  if (!parsed.success) throw new Error('fixture_invalid_read_fault');
  return parsed.data;
}

const refundFaultSchema = z.object({ noteId: z.string().uuid(),
  mode: z.enum(['none', 'partial', 'full']) }).strict();
export function fixtureRefundFault(body: unknown) {
  const parsed = refundFaultSchema.safeParse(body);
  if (!parsed.success) throw new Error('fixture_invalid_refund_fault');
  return parsed.data;
}
