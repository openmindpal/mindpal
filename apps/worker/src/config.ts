export type WorkerConfig = {
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
  };
  media: {
    fsRootDir: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    db: {
      host: env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(env.POSTGRES_PORT ?? 5432),
      database: env.POSTGRES_DB ?? "openslin",
      user: env.POSTGRES_USER ?? "openslin",
      password: env.POSTGRES_PASSWORD ?? "openslin",
    },
    redis: {
      host: env.REDIS_HOST ?? "127.0.0.1",
      port: Number(env.REDIS_PORT ?? 6379),
    },
    media: {
      fsRootDir: env.MEDIA_FS_ROOT_DIR ?? "var/media",
    },
  };
}
