import { loadDbConfig, loadRedisConfig, loadMasterKey, type DbConfig, type RedisConfig } from "@openslin/shared";

export type ApiConfig = {
  port: number;
  db: DbConfig;
  redis: RedisConfig;
  platformLocale: string;
  cors: {
    allowedOrigins: string[];
  };
  secrets: {
    masterKey: string;
  };
  media: {
    fsRootDir: string;
    upload: {
      maxPartBytes: number;
      maxTotalBytes: number;
      expiresSec: number;
    };
  };
};

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const isProduction = env.NODE_ENV === "production";
  if (isProduction && !env.API_CORS_ORIGINS) {
    throw new Error(
      "[config] API_CORS_ORIGINS must be explicitly set in production. " +
      "Example: API_CORS_ORIGINS=https://app.example.com"
    );
  }
  const allowedOrigins =
    (env.API_CORS_ORIGINS ?? "http://localhost:4000,http://127.0.0.1:4000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    port: Number(env.API_PORT ?? 3001),
    db: loadDbConfig(env),
    redis: loadRedisConfig(env),
    platformLocale: env.PLATFORM_LOCALE ?? "zh-CN",
    cors: { allowedOrigins },
    secrets: { masterKey: loadMasterKey(env) },
    media: {
      fsRootDir: env.MEDIA_FS_ROOT_DIR ?? "var/media",
      upload: {
        maxPartBytes: Number(env.MEDIA_UPLOAD_MAX_PART_BYTES ?? 5 * 1024 * 1024),
        maxTotalBytes: Number(env.MEDIA_UPLOAD_MAX_TOTAL_BYTES ?? 50 * 1024 * 1024),
        expiresSec: Number(env.MEDIA_UPLOAD_EXPIRES_SEC ?? 3600),
      },
    },
  };
}
