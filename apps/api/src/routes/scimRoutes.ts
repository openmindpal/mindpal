/**
 * SCIM 2.0 Routes — architecture-05 section 15.15
 * Implements: /scim/v2/Users, /scim/v2/Groups endpoints for enterprise IdP provisioning.
 *
 * 功能目标：提供符合RFC 7643/7644标准的SCIM端点，支持Azure AD/Okta等IdP自动供给。
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import {
  verifyScimToken,
  listScimUsers,
  getScimUserById,
  getScimUserByExternalId,
  createScimUser,
  updateScimUser,
  deleteScimUser,
  listScimGroups,
  getScimGroupById,
  getScimGroupByExternalId,
  createScimGroup,
  updateScimGroup,
  deleteScimGroup,
  buildScimUserResponse,
  buildScimGroupResponse,
  buildScimListResponse,
  buildScimError,
  recordScimSyncEvent,
  type ScimUser,
  type ScimGroup,
  type ScimProvisionedUserRow,
  type ScimProvisionedGroupRow,
  type ScimConfigRow,
} from "../modules/auth/scimRuntime";

export const scimRoutes: FastifyPluginAsync = async (app) => {
  /* ─── SCIM Authentication Middleware ─── */
  async function authenticateScim(req: any): Promise<{ tenantId: string; config: ScimConfigRow }> {
    const tenantId = String(req.headers["x-tenant-id"] ?? "").trim();
    if (!tenantId) {
      throw Errors.unauthorized(req.ctx?.locale);
    }

    const authHeader = String(req.headers.authorization ?? "").trim();
    if (!authHeader.startsWith("Bearer ")) {
      throw Errors.unauthorized(req.ctx?.locale);
    }

    const bearerToken = authHeader.slice(7).trim();
    const config = await verifyScimToken({ pool: app.db, tenantId, bearerToken });
    if (!config) {
      throw Errors.unauthorized(req.ctx?.locale);
    }

    return { tenantId, config };
  }

  function checkOperation(config: ScimConfigRow, operation: string): void {
    if (!config.allowedOperations.includes(operation)) {
      throw Errors.forbidden();
    }
  }

  function getBaseUrl(req: any): string {
    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    return `${proto}://${host}`;
  }

  /* ─── SCIM Service Provider Config ─── */
  app.get("/scim/v2/ServiceProviderConfig", async (req, reply) => {
    setAuditContext(req, { resourceType: "scim", action: "service_provider_config" });
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://docs.openslin.io/scim",
      patch: { supported: false },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 100 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Authentication scheme using OAuth 2.0 Bearer Token",
          specUri: "https://tools.ietf.org/html/rfc6750",
          primary: true,
        },
      ],
    };
  });

  /* ─── SCIM Resource Types ─── */
  app.get("/scim/v2/ResourceTypes", async (req, reply) => {
    setAuditContext(req, { resourceType: "scim", action: "resource_types" });
    const baseUrl = getBaseUrl(req);
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/scim/v2/Users",
          schema: "urn:ietf:params:scim:schemas:core:2.0:User",
          meta: { location: `${baseUrl}/scim/v2/ResourceTypes/User`, resourceType: "ResourceType" },
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/scim/v2/Groups",
          schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
          meta: { location: `${baseUrl}/scim/v2/ResourceTypes/Group`, resourceType: "ResourceType" },
        },
      ],
    };
  });

  /* ─── SCIM Schemas ─── */
  app.get("/scim/v2/Schemas", async (req, reply) => {
    setAuditContext(req, { resourceType: "scim", action: "schemas" });
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
          id: "urn:ietf:params:scim:schemas:core:2.0:User",
          name: "User",
          description: "User resource",
          attributes: [
            { name: "userName", type: "string", required: true, mutability: "readWrite", returned: "default", uniqueness: "server" },
            { name: "displayName", type: "string", required: false, mutability: "readWrite", returned: "default" },
            { name: "emails", type: "complex", required: false, mutability: "readWrite", returned: "default", multiValued: true },
            { name: "active", type: "boolean", required: false, mutability: "readWrite", returned: "default" },
          ],
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
          id: "urn:ietf:params:scim:schemas:core:2.0:Group",
          name: "Group",
          description: "Group resource",
          attributes: [
            { name: "displayName", type: "string", required: true, mutability: "readWrite", returned: "default", uniqueness: "server" },
            { name: "members", type: "complex", required: false, mutability: "readWrite", returned: "default", multiValued: true },
          ],
        },
      ],
    };
  });

  /* ─── List Users ─── */
  app.get("/scim/v2/Users", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Users.list");
    setAuditContext(req, { resourceType: "scim", action: "users.list" });

    const query = req.query as Record<string, string>;
    const startIndex = parseInt(query.startIndex || "1", 10);
    const count = parseInt(query.count || "20", 10);
    const filter = query.filter;

    const { users, totalResults } = await listScimUsers({ pool: app.db, tenantId, startIndex, count, filter });
    const baseUrl = getBaseUrl(req);

    const scimUsers = users.map((u: ScimProvisionedUserRow) => buildScimUserResponse(u, baseUrl));
    return buildScimListResponse({ resources: scimUsers, totalResults, startIndex, itemsPerPage: users.length });
  });

  /* ─── Get User by ID ─── */
  app.get("/scim/v2/Users/:id", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Users.get");
    setAuditContext(req, { resourceType: "scim", action: "users.get" });

    const { id } = req.params as { id: string };
    const user = await getScimUserById({ pool: app.db, tenantId, scimUserId: id });
    if (!user) {
      reply.status(404);
      return buildScimError(404, `User ${id} not found`, "invalidValue");
    }

    const baseUrl = getBaseUrl(req);
    return buildScimUserResponse(user, baseUrl);
  });

  /* ─── Create User ─── */
  app.post("/scim/v2/Users", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Users.create");
    setAuditContext(req, { resourceType: "scim", action: "users.create" });

    const body = req.body as ScimUser;
    if (!body.userName) {
      reply.status(400);
      return buildScimError(400, "userName is required", "invalidValue");
    }

    const externalId = body.externalId || body.userName;
    const email = body.emails?.find((e: { value: string; primary?: boolean }) => e.primary)?.value || body.emails?.[0]?.value;

    try {
      // Check if user already exists
      const existing = await getScimUserByExternalId({ pool: app.db, tenantId, externalId });
      if (existing) {
        reply.status(409);
        return buildScimError(409, `User with externalId ${externalId} already exists`, "uniqueness");
      }

      const user = await createScimUser({
        pool: app.db,
        tenantId,
        externalId,
        subjectId: body.userName,
        displayName: body.displayName || body.name?.formatted,
        email,
        active: body.active ?? true,
        config,
      });

      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "create",
        externalId,
        subjectId: body.userName,
        result: "success",
      });

      const baseUrl = getBaseUrl(req);
      reply.status(201);
      return buildScimUserResponse(user, baseUrl);
    } catch (err: any) {
      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "create",
        externalId,
        subjectId: body.userName,
        result: "error",
        errorMessage: err.message,
      });
      throw err;
    }
  });

  /* ─── Update User (PUT - full replace) ─── */
  app.put("/scim/v2/Users/:id", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Users.update");
    setAuditContext(req, { resourceType: "scim", action: "users.update" });

    const { id } = req.params as { id: string };
    const body = req.body as ScimUser;

    const existing = await getScimUserById({ pool: app.db, tenantId, scimUserId: id });
    if (!existing) {
      reply.status(404);
      return buildScimError(404, `User ${id} not found`, "invalidValue");
    }

    req.ctx.audit!.inputDigest = { ...(req.ctx.audit!.inputDigest as any ?? {}), before: { userName: existing.subjectId, displayName: existing.displayName, emails: existing.email ? [{ value: existing.email }] : [], active: existing.active } };

    const email = body.emails?.find((e: { value: string; primary?: boolean }) => e.primary)?.value || body.emails?.[0]?.value;

    try {
      const user = await createScimUser({
        pool: app.db,
        tenantId,
        externalId: existing.externalId,
        subjectId: body.userName || existing.subjectId,
        displayName: body.displayName || body.name?.formatted,
        email,
        active: body.active ?? true,
        config,
      });

      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "update",
        externalId: existing.externalId,
        subjectId: user.subjectId,
        result: "success",
      });

      const baseUrl = getBaseUrl(req);
      return buildScimUserResponse(user, baseUrl);
    } catch (err: any) {
      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "update",
        externalId: existing.externalId,
        subjectId: existing.subjectId,
        result: "error",
        errorMessage: err.message,
      });
      throw err;
    }
  });

  /* ─── Delete User ─── */
  app.delete("/scim/v2/Users/:id", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Users.delete");
    setAuditContext(req, { resourceType: "scim", action: "users.delete" });

    const { id } = req.params as { id: string };
    const existing = await getScimUserById({ pool: app.db, tenantId, scimUserId: id });
    if (!existing) {
      reply.status(404);
      return buildScimError(404, `User ${id} not found`, "invalidValue");
    }

    req.ctx.audit!.outputDigest = { ...(req.ctx.audit!.outputDigest as any ?? {}), snapshot: { userName: existing.subjectId, displayName: existing.displayName, emails: existing.email ? [{ value: existing.email }] : [], active: existing.active, groups: (existing as any).groups ?? [] } };

    try {
      await deleteScimUser({ pool: app.db, tenantId, scimUserId: id });

      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "delete",
        externalId: existing.externalId,
        subjectId: existing.subjectId,
        result: "success",
      });

      reply.status(204);
      return;
    } catch (err: any) {
      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "delete",
        externalId: existing.externalId,
        subjectId: existing.subjectId,
        result: "error",
        errorMessage: err.message,
      });
      throw err;
    }
  });

  /* ─── List Groups ─── */
  app.get("/scim/v2/Groups", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Groups.list");
    setAuditContext(req, { resourceType: "scim", action: "groups.list" });

    const query = req.query as Record<string, string>;
    const startIndex = parseInt(query.startIndex || "1", 10);
    const count = parseInt(query.count || "20", 10);
    const filter = query.filter;

    const { groups, totalResults } = await listScimGroups({ pool: app.db, tenantId, startIndex, count, filter });
    const baseUrl = getBaseUrl(req);

    const scimGroups = groups.map((g: ScimProvisionedGroupRow) => buildScimGroupResponse(g, baseUrl));
    return buildScimListResponse({ resources: scimGroups, totalResults, startIndex, itemsPerPage: groups.length });
  });

  /* ─── Get Group by ID ─── */
  app.get("/scim/v2/Groups/:id", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Groups.get");
    setAuditContext(req, { resourceType: "scim", action: "groups.get" });

    const { id } = req.params as { id: string };
    const group = await getScimGroupById({ pool: app.db, tenantId, scimGroupId: id });
    if (!group) {
      reply.status(404);
      return buildScimError(404, `Group ${id} not found`, "invalidValue");
    }

    const baseUrl = getBaseUrl(req);
    return buildScimGroupResponse(group, baseUrl);
  });

  /* ─── Create Group ─── */
  app.post("/scim/v2/Groups", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Groups.create");
    setAuditContext(req, { resourceType: "scim", action: "groups.create" });

    const body = req.body as ScimGroup;
    if (!body.displayName) {
      reply.status(400);
      return buildScimError(400, "displayName is required", "invalidValue");
    }

    const externalId = body.externalId || body.displayName;

    try {
      const existing = await getScimGroupByExternalId({ pool: app.db, tenantId, externalId });
      if (existing) {
        reply.status(409);
        return buildScimError(409, `Group with externalId ${externalId} already exists`, "uniqueness");
      }

      const group = await createScimGroup({
        pool: app.db,
        tenantId,
        externalId,
        displayName: body.displayName,
        members: body.members?.map(m => ({ value: m.value, display: m.display })),
        active: true,
        config,
      });

      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "group.create",
        externalId,
        subjectId: "group:" + body.displayName,
        result: "success",
      });

      const baseUrl = getBaseUrl(req);
      reply.status(201);
      return buildScimGroupResponse(group, baseUrl);
    } catch (err: any) {
      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "group.create",
        externalId,
        subjectId: "group:" + body.displayName,
        result: "error",
        errorMessage: err.message,
      });
      throw err;
    }
  });

  /* ─── Update Group (PUT - full replace) ─── */
  app.put("/scim/v2/Groups/:id", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Groups.update");
    setAuditContext(req, { resourceType: "scim", action: "groups.update" });

    const { id } = req.params as { id: string };
    const body = req.body as ScimGroup;

    const existing = await getScimGroupById({ pool: app.db, tenantId, scimGroupId: id });
    if (!existing) {
      reply.status(404);
      return buildScimError(404, `Group ${id} not found`, "invalidValue");
    }

    req.ctx.audit!.inputDigest = { ...(req.ctx.audit!.inputDigest as any ?? {}), before: { displayName: existing.displayName, memberCount: (existing as any).memberCount ?? 0 } };

    try {
      const group = await updateScimGroup({
        pool: app.db,
        tenantId,
        scimGroupId: id,
        displayName: body.displayName || existing.displayName,
        members: body.members?.map(m => ({ value: m.value, display: m.display })),
        active: true,
        config,
      });

      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "group.update",
        externalId: existing.externalId,
        subjectId: "group:" + (body.displayName || existing.displayName),
        result: "success",
      });

      const baseUrl = getBaseUrl(req);
      return buildScimGroupResponse(group!, baseUrl);
    } catch (err: any) {
      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "group.update",
        externalId: existing.externalId,
        subjectId: "group:" + existing.displayName,
        result: "error",
        errorMessage: err.message,
      });
      throw err;
    }
  });

  /* ─── Delete Group ─── */
  app.delete("/scim/v2/Groups/:id", async (req, reply) => {
    const { tenantId, config } = await authenticateScim(req);
    checkOperation(config, "Groups.delete");
    setAuditContext(req, { resourceType: "scim", action: "groups.delete" });

    const { id } = req.params as { id: string };
    const existing = await getScimGroupById({ pool: app.db, tenantId, scimGroupId: id });
    if (!existing) {
      reply.status(404);
      return buildScimError(404, `Group ${id} not found`, "invalidValue");
    }

    req.ctx.audit!.outputDigest = { ...(req.ctx.audit!.outputDigest as any ?? {}), snapshot: { displayName: existing.displayName, memberCount: (existing as any).memberCount ?? 0, members: (existing as any).members ?? [] } };

    try {
      await deleteScimGroup({ pool: app.db, tenantId, scimGroupId: id });

      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "group.delete",
        externalId: existing.externalId,
        subjectId: "group:" + existing.displayName,
        result: "success",
      });

      reply.status(204);
      return;
    } catch (err: any) {
      await recordScimSyncEvent({
        pool: app.db,
        tenantId,
        operation: "group.delete",
        externalId: existing.externalId,
        subjectId: "group:" + existing.displayName,
        result: "error",
        errorMessage: err.message,
      });
      throw err;
    }
  });
};
