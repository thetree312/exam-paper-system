import test from "node:test"
import assert from "node:assert/strict"

import { createAuthService, type CloudAuthUserRecord } from "../src/domains/auth/service"

function createCloudUser(overrides: Partial<CloudAuthUserRecord> = {}): CloudAuthUserRecord {
  return {
    id: "42",
    tenantID: 7,
    email: "user@example.com",
    displayName: "Example User",
    passwordHash: "hashed-password",
    accountStatus: 1,
    subscription: {
      plan: "free",
      status: "inactive",
    },
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
    ...overrides,
  }
}

test("register is disabled and never creates local accounts", async () => {
  const service = createAuthService({
    cloudAuth: {
      findUserByEmail: async () => null,
      getUserByID: async () => null,
      updatePasswordHash: async () => undefined,
    },
    localSessions: {
      create: async () => {
        throw new Error("session should not be created")
      },
      resolve: async () => null,
      delete: async () => undefined,
    },
    passwordAuth: {
      verify: async () => ({ isValid: false, needsUpgrade: false }),
      hash: async () => "unused",
    },
  })

  await assert.rejects(
    () => service.register({ email: "user@example.com", password: "Password123!" }),
    /Registration is disabled/i,
  )
})

test("login validates against cloud auth and creates a local session", async () => {
  const cloudUser = createCloudUser()
  let createdForUserID = ""

  const service = createAuthService({
    cloudAuth: {
      findUserByEmail: async (email) => (email === cloudUser.email ? cloudUser : null),
      getUserByID: async (userID) => (userID === cloudUser.id ? cloudUser : null),
      updatePasswordHash: async () => undefined,
    },
    localSessions: {
      create: async (user) => {
        createdForUserID = user.id
        return {
          id: "auth_session_1",
          token: "token-1",
          userID: user.id,
          createdAt: "2026-04-18T00:00:00.000Z",
          lastUsedAt: "2026-04-18T00:00:00.000Z",
        }
      },
      resolve: async () => null,
      delete: async () => undefined,
    },
    passwordAuth: {
      verify: async (password, storedHash) => ({
        isValid: password === "Password123!" && storedHash === cloudUser.passwordHash,
        needsUpgrade: false,
      }),
      hash: async () => "unused",
    },
  })

  const result = await service.login({
    email: cloudUser.email,
    password: "Password123!",
  })

  assert.equal(createdForUserID, cloudUser.id)
  assert.equal(result.sessionID, "auth_session_1")
  assert.equal(result.token, "token-1")
  assert.equal(result.user.id, cloudUser.id)
  assert.equal(result.user.tenantID, cloudUser.tenantID)
})

test("resolveSession reloads the latest cloud user profile from source of truth", async () => {
  const sessionUser = createCloudUser({ displayName: "Old Name" })
  const latestCloudUser = createCloudUser({ displayName: "New Name" })

  const service = createAuthService({
    cloudAuth: {
      findUserByEmail: async () => null,
      getUserByID: async (userID) => (userID === latestCloudUser.id ? latestCloudUser : null),
      updatePasswordHash: async () => undefined,
    },
    localSessions: {
      create: async () => {
        throw new Error("not used")
      },
      resolve: async (token) =>
        token === "token-1"
          ? {
              id: "auth_session_1",
              token,
              userID: sessionUser.id,
              createdAt: "2026-04-18T00:00:00.000Z",
              lastUsedAt: "2026-04-18T00:00:00.000Z",
            }
          : null,
      delete: async () => undefined,
    },
    passwordAuth: {
      verify: async () => ({ isValid: false, needsUpgrade: false }),
      hash: async () => "unused",
    },
  })

  const result = await service.resolveSession("token-1")

  assert.equal(result.user.displayName, "New Name")
  assert.equal(result.session.id, "auth_session_1")
})

test("login can trigger post-login local ownership migration for legacy local data", async () => {
  const cloudUser = createCloudUser()
  let migratedUserID = ""

  const service = createAuthService({
    cloudAuth: {
      findUserByEmail: async () => cloudUser,
      getUserByID: async () => cloudUser,
      updatePasswordHash: async () => undefined,
    },
    localSessions: {
      create: async (user) => ({
        id: "auth_session_1",
        token: "token-1",
        userID: user.id,
        createdAt: "2026-04-18T00:00:00.000Z",
        lastUsedAt: "2026-04-18T00:00:00.000Z",
      }),
      resolve: async () => null,
      delete: async () => undefined,
    },
    passwordAuth: {
      verify: async () => ({ isValid: true, needsUpgrade: false }),
      hash: async () => "unused",
    },
    afterLogin: async (user) => {
      migratedUserID = user.id
    },
  })

  await service.login({
    email: cloudUser.email,
    password: "Password123!",
  })

  assert.equal(migratedUserID, cloudUser.id)
})
