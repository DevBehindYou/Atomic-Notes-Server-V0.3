import { z } from 'zod';

/** Additive storage contract only. No default/backfill or credit issuance. */
export const refundCreditMetadataSchema = z.object({
  refundCreditFormat: z.literal(1).optional(),
  heldRefundEnergy: z.number().refine(Number.isInteger).nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).superRefine((metadata, ctx) => {
  const explicit = Object.hasOwn(metadata, 'refundCreditFormat') || Object.hasOwn(metadata, 'heldRefundEnergy');
  if (explicit && (metadata.refundCreditFormat === undefined || metadata.heldRefundEnergy === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Refund credit metadata requires format and held energy', path: ['heldRefundEnergy'] });
  }
});

/** Informational held value only; never added to spendable Energy. */
export function readHeldRefundEnergy(wallet: unknown): number {
  const result = refundCreditMetadataSchema.safeParse(wallet);
  // Stored wallet corruption is a server error, never a caller validation error.
  // Do not expose validation issues or values through request error handling.
  if (!result.success) throw new Error('invalid_refund_credit_metadata');
  return result.data.heldRefundEnergy ?? 0;
}
