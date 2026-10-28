import { z } from "zod";

/**
 * Typed configuration from environment variables (ARCHITECTURE §10).
 *
 * Values never appear in error messages: a bad variable is reported by name
 * only, because several of them are secrets. Prices are never configured here;
 * plans point at provider price IDs and display prices come from the provider.
 */

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const nonNegativeInt = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const flag = (fallback: boolean) => z.stringbool().default(fallback);
const secret = z.string().min(32, "must be at least 32 characters");

const emailList = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.email()));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url().default("http://localhost:3000"),

    DATABASE_URL: z.string({ error: "is required" }).min(1, "is required"),
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),

    PAYMENT_PROVIDER: z.enum(["stripe", "fake"]).default("fake"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
    STRIPE_PRICE_PRO_ANNUAL: z.string().optional(),
    // v1 runs Stripe in test mode only (PRD D3); live keys need an explicit opt-in.
    STRIPE_ALLOW_LIVE: flag(false),

    LICENSE_SIGNING_KEYS: z.string().optional(),
    LICENSE_ACTIVE_KID: z.string().optional(),
    KEY_HASH_PEPPER: secret.optional(),
    SESSION_SECRET: secret.optional(),

    EMAIL_PROVIDER: z.enum(["console", "resend", "acs"]).default("console"),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    OWNER_EMAILS: emailList,

    TOKEN_TTL_DAYS: positiveInt(7),
    TOKEN_REFRESH_HOURS: positiveInt(24),
    DEFAULT_DEVICE_LIMIT: positiveInt(2),
    TRANSFER_COOLDOWN_HOURS: nonNegativeInt(24),
    TRIAL_DAYS: nonNegativeInt(0),
    AUDIT_RETENTION_YEARS: positiveInt(5),
    DEVICE_PURGE_MONTHS: positiveInt(12),

    FLAG_TRIALS: flag(false),
    FLAG_SELF_SERVE_TRANSFER: flag(true),
  })
  .superRefine((env, ctx) => {
    const missing = (path: string) => ctx.addIssue({ code: "custom", path: [path], message: "is required" });

    if (env.PAYMENT_PROVIDER === "stripe") {
      for (const key of [
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_PRO_MONTHLY",
        "STRIPE_PRICE_PRO_ANNUAL",
      ] as const) {
        if (!env[key]) missing(key);
      }
      if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_") && !env.STRIPE_ALLOW_LIVE) {
        ctx.addIssue({
          code: "custom",
          path: ["STRIPE_SECRET_KEY"],
          message: "must be a test-mode key (sk_test_…) unless STRIPE_ALLOW_LIVE=true",
        });
      }
    }
    if (env.PAYMENT_PROVIDER === "fake" && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"], message: "cannot be 'fake' in production" });
    }
    if (env.EMAIL_PROVIDER !== "console") {
      if (!env.EMAIL_API_KEY) missing("EMAIL_API_KEY");
      if (!env.EMAIL_FROM) missing("EMAIL_FROM");
    }
    if (env.FLAG_TRIALS && env.TRIAL_DAYS === 0) {
      ctx.addIssue({ code: "custom", path: ["TRIAL_DAYS"], message: "must be > 0 when FLAG_TRIALS=true" });
    }
    if (env.TOKEN_REFRESH_HOURS >= env.TOKEN_TTL_DAYS * 24) {
      ctx.addIssue({
        code: "custom",
        path: ["TOKEN_REFRESH_HOURS"],
        message: "must be shorter than TOKEN_TTL_DAYS",
      });
    }
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Pure: validates an env-like record. Exported for tests. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  // Empty strings count as unset, so `FOO=` in a .env file falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}

let cached: Config | undefined;

/** Reads process.env once per process. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
