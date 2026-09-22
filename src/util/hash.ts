import { createHash } from 'node:crypto';
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
export function shortHash(data: Buffer | string, len = 12): string {
  return sha256(data).slice(0, len);
}
