import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('8080').transform(Number),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  INTERNAL_SECRET: z.string().min(8),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
