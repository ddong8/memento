// bcrypt hashes as Python's bcrypt writes them ($2b$, cost 12).
import bcrypt from "bcryptjs";

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    return bcrypt.compareSync(plain, hashed);
  } catch {
    return false;
  }
}
