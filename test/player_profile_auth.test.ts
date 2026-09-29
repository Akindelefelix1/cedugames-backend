import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, verify } = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn() }));
vi.mock("../src/config/database_connection", () => ({ default: { query } }));
vi.mock("jsonwebtoken", () => ({ default: { verify } }));

import { verifyPlayerToken, type AuthenticatedRequest } from "../src/middlewares/authentication_middleware";

const accountId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";

function response() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe("player profile authorization", () => {
  beforeEach(() => {
    query.mockReset(); verify.mockReset();
    verify.mockReturnValue({ id: accountId, role: "user", ver: 3 });
    query.mockResolvedValueOnce({ rows: [{ role: "user", token_version: 3, parent_user_id: null }] });
  });

  it("uses the household account as the default player", async () => {
    const req = { headers: { authorization: "Bearer valid" } } as AuthenticatedRequest;
    const res = response(), next = vi.fn();
    await verifyPlayerToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: accountId, accountId });
  });

  it("switches only to a child owned by the signed-in account", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: childId }] });
    const req = { headers: { authorization: "Bearer valid", "x-player-profile-id": childId } } as unknown as AuthenticatedRequest;
    const res = response(), next = vi.fn();
    await verifyPlayerToken(req, res, next);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("parent_user_id=$2"), [childId, accountId]);
    expect(req.user).toMatchObject({ id: childId, accountId });
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects profiles outside the household", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const req = { headers: { authorization: "Bearer valid", "x-player-profile-id": childId } } as unknown as AuthenticatedRequest;
    const res = response(), next = vi.fn();
    await verifyPlayerToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PROFILE_FORBIDDEN" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects malformed profile identifiers without querying PostgreSQL", async () => {
    const req = { headers: { authorization: "Bearer valid", "x-player-profile-id": "not-a-uuid" } } as unknown as AuthenticatedRequest;
    const res = response(), next = vi.fn();
    await verifyPlayerToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PROFILE_INVALID" }));
    expect(query).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});
