import { z } from 'zod';
const failureSchema = z.object({ ids: z.array(z.string().uuid()).max(50)
  .refine((ids) => new Set(ids).size === ids.length) }).strict();
export function fixtureFailureIds(body: unknown): Set<string> {
  const parsed = failureSchema.safeParse(body);
  if (!parsed.success) throw new Error('fixture_invalid_failure_ids');
  return new Set(parsed.data.ids);
}
