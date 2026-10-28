// Prints a new Ed25519 signing key for LICENSE_SIGNING_KEYS (ARCHITECTURE §8).
//
//   node scripts/generate-signing-key.mjs [kid]
//
// To rotate: append the new key to the existing JSON array, publish (JWKS), ship
// a Levelset build that embeds both public keys, then set LICENSE_ACTIVE_KID to
// the new kid. Remove the old key only after the longest token TTL has passed.
// The output is a secret: put it in the host's secret store, never in a file in this repo.
import { exportJWK, generateKeyPair } from "jose";

const kid = process.argv[2] ?? new Date().toISOString().slice(0, 7); // e.g. 2026-10
const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid, alg: "EdDSA", use: "sig" };

console.log(`LICENSE_SIGNING_KEYS='${JSON.stringify([jwk])}'`);
console.log(`LICENSE_ACTIVE_KID=${kid}`);
