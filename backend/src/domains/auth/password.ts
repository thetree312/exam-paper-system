import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto"

const PBKDF2_PREFIX = "pbkdf2_sha256"
const PBKDF2_ITERATIONS = 390_000
const PBKDF2_SALT_BYTES = 16

export type PasswordVerifyResult = {
  isValid: boolean
  needsUpgrade: boolean
}

export function hashCloudPassword(password: string) {
  const salt = randomBytes(PBKDF2_SALT_BYTES)
  const derived = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256")
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`
}

function hashLegacyPassword(password: string) {
  return createHash("sha256").update(password, "utf8").digest("hex")
}

function isPbkdf2Hash(storedHash: string) {
  return storedHash.startsWith(`${PBKDF2_PREFIX}$`)
}

export function verifyCloudPassword(password: string, storedHash: string): PasswordVerifyResult {
  if (isPbkdf2Hash(storedHash)) {
    try {
      const [, iterString, saltHex, derivedHex] = storedHash.split("$", 4)
      const iterations = Number(iterString)
      const salt = Buffer.from(saltHex, "hex")
      const expected = Buffer.from(derivedHex, "hex")
      const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256")
      return {
        isValid: expected.length === actual.length && timingSafeEqual(expected, actual),
        needsUpgrade: iterations < PBKDF2_ITERATIONS,
      }
    } catch {
      return {
        isValid: false,
        needsUpgrade: true,
      }
    }
  }

  const legacy = hashLegacyPassword(password)
  return {
    isValid: timingSafeEqual(Buffer.from(legacy), Buffer.from(storedHash)),
    needsUpgrade: true,
  }
}
