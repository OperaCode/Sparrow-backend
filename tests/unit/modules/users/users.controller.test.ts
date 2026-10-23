import type { Request, RequestHandler, Response } from "express";
import { describe, expect, it } from "vitest";
import { createUsersController } from "#src/modules/users/users.controller.js";
import {
  OTHER_USER_ID,
  recordingUsersService,
  userProfile,
  usersService,
} from "../../../helpers/user.factory.js";

const profile = userProfile();
const auth = { userId: profile.id, role: profile.role };

interface Captured {
  statusCode: number;
  body: unknown;
}

function capture(): { res: Response; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, captured };
}

async function run(
  handler: RequestHandler,
  req: Partial<Request>,
): Promise<Captured> {
  const { res, captured } = capture();
  await handler(req as Request, res, () => undefined);
  return captured;
}

describe("users controller", () => {
  it("returns 401 when the request has no authenticated user", async () => {
    const controller = createUsersController(usersService());

    await expect(run(controller.show, {})).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
    });
    await expect(
      run(controller.update, { body: { name: "Ada" } }),
    ).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(run(controller.deactivate, {})).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(run(controller.provision, { body: {} })).rejects.toMatchObject(
      {
        statusCode: 401,
      },
    );
    await expect(
      run(controller.setStatus, { params: { id: profile.id }, body: {} }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      run(controller.setRole, { params: { id: profile.id }, body: {} }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("shows the profile for the authenticated user", async () => {
    const { service, calls } = recordingUsersService(
      "getProfile",
      () => profile,
    );
    const controller = createUsersController(service);

    const captured = await run(controller.show, { auth });

    expect(calls).toEqual([[auth.userId]]);
    expect(captured).toEqual({ statusCode: 200, body: { data: profile } });
  });

  it("updates the authenticated user with the request body", async () => {
    const patch = { name: "Ada", community: "ketu" as const };
    const { service, calls } = recordingUsersService(
      "updateOwnProfile",
      () => ({ ...profile, ...patch }),
    );
    const controller = createUsersController(service);

    const captured = await run(controller.update, { auth, body: patch });

    expect(calls).toEqual([[auth.userId, patch]]);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      data: { id: profile.id, name: "Ada", community: "ketu" },
    });
  });

  it("deactivates the authenticated user", async () => {
    const { service, calls } = recordingUsersService(
      "deactivateOwnAccount",
      () => ({ ...profile, status: "deactivated" }),
    );
    const controller = createUsersController(service);

    const captured = await run(controller.deactivate, { auth });

    expect(calls).toEqual([[auth.userId]]);
    expect(captured).toMatchObject({
      statusCode: 200,
      body: { data: { status: "deactivated" } },
    });
  });

  it("provisions an account for the authenticated admin", async () => {
    const input = { phone: "+2348011111111", role: "admin" as const };
    const requestId = "req-provision";
    const { service, calls } = recordingUsersService(
      "provisionAccount",
      () => ({ ...profile, ...input }),
    );
    const controller = createUsersController(service);

    const captured = await run(controller.provision, {
      auth: { userId: auth.userId, role: "admin" },
      id: requestId,
      body: input,
    });

    expect(calls).toEqual([[{ actorId: auth.userId, requestId }, input]]);
    expect(captured.statusCode).toBe(201);
    expect(captured.body).toMatchObject({
      data: { phone: input.phone, role: "admin" },
    });
  });

  it("sets another account status from the route id and body", async () => {
    const requestId = "req-status";
    const { service, calls } = recordingUsersService(
      "setAccountStatus",
      (_actor, id, status) => ({ ...profile, id, status }),
    );
    const controller = createUsersController(service);

    const captured = await run(controller.setStatus, {
      auth: { userId: auth.userId, role: "admin" },
      id: requestId,
      params: { id: OTHER_USER_ID },
      body: { status: "deactivated" },
    });

    expect(calls).toEqual([
      [{ actorId: auth.userId, requestId }, OTHER_USER_ID, "deactivated"],
    ]);
    expect(captured).toMatchObject({
      statusCode: 200,
      body: { data: { id: OTHER_USER_ID, status: "deactivated" } },
    });
  });

  it("sets another account role from the route id and body", async () => {
    const requestId = "req-role";
    const { service, calls } = recordingUsersService(
      "setAccountRole",
      (_actor, id, role) => ({ ...profile, id, role }),
    );
    const controller = createUsersController(service);

    const captured = await run(controller.setRole, {
      auth: { userId: auth.userId, role: "admin" },
      id: requestId,
      params: { id: OTHER_USER_ID },
      body: { role: "admin" },
    });

    expect(calls).toEqual([
      [{ actorId: auth.userId, requestId }, OTHER_USER_ID, "admin"],
    ]);
    expect(captured).toMatchObject({
      statusCode: 200,
      body: { data: { id: OTHER_USER_ID, role: "admin" } },
    });
  });
});
