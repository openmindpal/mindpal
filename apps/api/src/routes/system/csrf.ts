import type { FastifyPluginAsync } from "fastify";

/**
 * GET /csrf-token — 为Cookie认证的前端客户端生成CSRF token
 *
 * Double-Submit Cookie 模式：
 * 1. 前端调用此端点获取 token
 * 2. 服务端同时通过 Set-Cookie 写入 mindpal_csrf cookie
 * 3. 前端在后续变更请求中将 token 放入 x-csrf-token header
 * 4. authMiddleware 校验 cookie 与 header 是否一致
 */
export const csrfRoutes: FastifyPluginAsync = async (app) => {
  app.get("/csrf-token", async (_req, reply) => {
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(32).toString("hex");
    reply.header(
      "set-cookie",
      `mindpal_csrf=${token}; Path=/; SameSite=Strict; HttpOnly=false`,
    );
    return { csrfToken: token };
  });
};
