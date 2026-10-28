import { randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { activations, licenses } from "@/db/schema";
import { type AuditActor, writeAudit } from "@/server/platform/audit";
import type { DbOrTx } from "@/server/platform/db";
import { keyedHash } from "@/server/platform/hashing";
import { updateAudited } from "@/server/platform/versioned";

/**
 * Licence keys (FR-16): `LSET-XXXXX-XXXXX-XXXXX-XXXXX`, Crockford base32.
 * 19 random symbols (95 bits) + 1 Luhn mod-32 check symbol, so the desktop
 * app catches typos and most swapped neighbours before calling the server.
 * Only a keyed hash is stored; the plaintext is shown once and never kept.
 */

export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const BODY_LENGTH = 19;
const PREFIX = "LSET";

const value = (c: string) => ALPHABET.indexOf(c);

/** Luhn mod N over the body, N = 32. */
export function checkSymbol(body: string): string {
  const n = ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * value(body[i]!);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return ALPHABET[(n - (sum % n)) % n]!;
}

function format(symbols: string): string {
  return `${PREFIX}-${symbols.match(/.{5}/g)!.join("-")}`;
}

export function generateKey(): string {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return format(body + checkSymbol(body));
}

/**
 * Canonical form of user input, or null if it isn't a valid key. Forgiving
 * like Crockford intends: case, spaces and dashes don't matter; O reads as 0,
 * I and L as 1.
 */
export function normalizeKey(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== BODY_LENGTH + 1 || [...s].some((c) => value(c) < 0)) return null;
  const body = s.slice(0, BODY_LENGTH);
  if (checkSymbol(body) !== s[BODY_LENGTH]) return null;
  return format(s);
}

export const keyHint = (canonical: string) => canonical.slice(-4);
export const hashKey = (pepper: string, canonical: string) => keyedHash(pepper, canonical);

export type IssueKeyInput = {
  licenseId: string;
  expectedVersion: number;
  actor: AuditActor;
  pepper: string;
  reason?: string | null;
  requestId?: string | null;
};

/**
 * Generates a new key for a licence and returns the plaintext (once). On a
 * rotation every active device is signed out, since it was activated with the
 * old key (FR-16).
 */
export async function issueKey(db: DbOrTx, input: IssueKeyInput): Promise<{ key: string; rotated: boolean; devicesSignedOut: number }> {
  const key = generateKey();
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ keyHash: licenses.keyHash }).from(licenses).where(eq(licenses.id, input.licenseId));
    const rotating = Boolean(current?.keyHash);
    const updated = await updateAudited(tx, {
      table: licenses,
      pk: licenses.id,
      id: input.licenseId,
      expectedVersion: input.expectedVersion,
      values: { keyHash: hashKey(input.pepper, key), keyHint: keyHint(key) },
      actor: input.actor,
      action: rotating ? "license.key_rotate" : "license.key_issue",
      reason: input.reason,
      requestId: input.requestId,
    });
    const signedOut = await tx
      .update(activations)
      .set({ deactivatedAt: new Date(), deactivatedBy: "rotation" })
      .where(and(eq(activations.licenseId, updated.id), isNull(activations.deactivatedAt)))
      .returning({ id: activations.id });
    if (signedOut.length) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "activation.deactivate_all",
        entityType: "licenses",
        entityId: updated.id,
        changes: { activeDevices: { from: signedOut.length, to: 0 } },
        reason: "key rotated",
        requestId: input.requestId,
      });
    }
    return { key, rotated: rotating, devicesSignedOut: signedOut.length };
  });
}
