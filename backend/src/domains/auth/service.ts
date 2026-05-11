import { CloudAuthRepository, type CloudAuthUserRecord } from "./cloud-auth-repository"
import { LocalAuthRepository } from "./local-auth-repository"
import { LocalSessionRepository, type AuthSessionRecord } from "./local-session-repository"
import { hashCloudPassword, verifyCloudPassword, type PasswordVerifyResult } from "./password"

export type { CloudAuthUserRecord } from "./cloud-auth-repository"

export class AuthDomainError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
  }
}

export type AuthPublicUser = {
  id: string
  tenantID: number
  email: string
  displayName: string
  subscription: {
    plan: string
    status: string
  }
  createdAt: string
  updatedAt: string
}

type AuthDependencies = {
  cloudAuth: {
    findUserByEmail(email: string): Promise<CloudAuthUserRecord | null>
    getUserByID(userID: string): Promise<CloudAuthUserRecord | null>
    updatePasswordHash(userID: string, passwordHash: string): Promise<void>
    createUser?(input: { email: string; password: string; displayName?: string }): Promise<CloudAuthUserRecord>
  }
  localSessions: {
    create(user: CloudAuthUserRecord): Promise<AuthSessionRecord>
    resolve(token: string): Promise<AuthSessionRecord | null>
    delete(token: string): Promise<void>
  }
  passwordAuth: {
    verify(password: string, storedHash: string): Promise<PasswordVerifyResult> | PasswordVerifyResult
    hash(password: string): Promise<string> | string
  }
  afterLogin?(user: CloudAuthUserRecord): Promise<void> | void
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function toPublicUser(user: CloudAuthUserRecord): AuthPublicUser {
  return {
    id: user.id,
    tenantID: user.tenantID,
    email: user.email,
    displayName: user.displayName,
    subscription: user.subscription,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export function createAuthService(deps: AuthDependencies) {
  return {
    async register(input: { email: string; password: string; displayName?: string }) {
      if (!deps.cloudAuth.createUser) {
        throw new AuthDomainError("Registration is disabled in local development. Please use the cloud account system.", 403)
      }
      const email = normalizeEmail(input.email)
      const password = input.password.trim()
      if (!email) throw new AuthDomainError("Email is required", 400)
      if (password.length < 8) throw new AuthDomainError("Password must be at least 8 characters", 400)

      const existing = await deps.cloudAuth.findUserByEmail(email)
      if (existing) throw new AuthDomainError("Email already registered", 400)

      const created = await deps.cloudAuth.createUser({
        email,
        password,
        displayName: input.displayName,
      })
      const session = await deps.localSessions.create(created)
      return {
        user: toPublicUser(created),
        token: session.token,
        sessionID: session.id,
      }
    },

    async login(input: { email: string; password: string }) {
      const email = normalizeEmail(input.email)
      const password = input.password.trim()
      if (!email) throw new AuthDomainError("Email is required", 400)
      if (password.length < 8) throw new AuthDomainError("Password must be at least 8 characters", 400)

      const user = await deps.cloudAuth.findUserByEmail(email)
      if (!user && deps.cloudAuth.createUser) {
        const bootstrapUser = await deps.cloudAuth.createUser({
          email,
          password,
          displayName: input.email.split("@")[0] || "Local User",
        })
        await deps.cloudAuth.reconcileLegacyDataForUser?.(bootstrapUser.id)
        const session = await deps.localSessions.create(bootstrapUser)
        return {
          user: toPublicUser(bootstrapUser),
          token: session.token,
          sessionID: session.id,
        }
      }
      if (!user) throw new AuthDomainError("Invalid email or password", 400)
      if (user.accountStatus !== 1) throw new AuthDomainError("Account is disabled", 403)

      const verification = await deps.passwordAuth.verify(password, user.passwordHash)
      if (!verification.isValid) throw new AuthDomainError("Invalid email or password", 400)

      if (verification.needsUpgrade) {
        const nextHash = await deps.passwordAuth.hash(password)
        await deps.cloudAuth.updatePasswordHash(user.id, nextHash)
      }

      await deps.afterLogin?.(user)

      const session = await deps.localSessions.create(user)
      return {
        user: toPublicUser(user),
        token: session.token,
        sessionID: session.id,
      }
    },

    async resolveSession(token: string) {
      const normalizedToken = token.trim()
      if (!normalizedToken) throw new AuthDomainError("Missing auth token", 401)

      const session = await deps.localSessions.resolve(normalizedToken)
      if (!session) throw new AuthDomainError("Invalid auth token", 401)

      const user = await deps.cloudAuth.getUserByID(session.userID)
      if (!user) throw new AuthDomainError(`Auth user not found: ${session.userID}`, 404)
      if (user.accountStatus !== 1) throw new AuthDomainError("Account is disabled", 403)

      return {
        user: toPublicUser(user),
        session,
      }
    },

    async getUserByID(userID: string) {
      const user = await deps.cloudAuth.getUserByID(userID)
      if (!user) throw new AuthDomainError(`Auth user not found: ${userID}`, 404)
      if (user.accountStatus !== 1) throw new AuthDomainError("Account is disabled", 403)
      return toPublicUser(user)
    },

    async logout(token: string) {
      const normalizedToken = token.trim()
      if (!normalizedToken) throw new AuthDomainError("Missing auth token", 401)
      await deps.localSessions.delete(normalizedToken)
    },
  }
}

const localAuthMode = process.env.LOCAL_AUTH_MODE === "1" || !process.env.DATABASE_URL

export const AuthService = createAuthService({
  cloudAuth: localAuthMode
    ? LocalAuthRepository
    : CloudAuthRepository,
  localSessions: LocalSessionRepository,
  passwordAuth: {
    verify: verifyCloudPassword,
    hash: hashCloudPassword,
  },
  afterLogin: localAuthMode
    ? undefined
    : async (user) => {
        const { migrateLegacyLocalStateForCloudUser } = await import("./user-local-state-migration")
        await migrateLegacyLocalStateForCloudUser(user)
      },
})
