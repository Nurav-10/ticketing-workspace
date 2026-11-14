import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  SESSION_COOKIE_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('app_session'),
  PUBLIC_ORIGIN: z.string().url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'must use HTTP or HTTPS')
    .refine((value) => new URL(value).origin === value, 'must be an origin without a path'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false')
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (parsed.data.NODE_ENV === 'production' && parsed.data.TRUST_PROXY === 'true') {
    throw new Error('Invalid environment: TRUST_PROXY=true requires an explicit bounded trusted-proxy policy');
  }
  if (parsed.data.NODE_ENV === 'production' && new URL(parsed.data.PUBLIC_ORIGIN).protocol !== 'https:') {
    throw new Error('Invalid environment: PUBLIC_ORIGIN must use HTTPS in production');
  }
  return parsed.data;
}
