// AES-256-GCM for secrets at rest (e.g. TOTP seeds, the Drive API key).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function createVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('vault key must be 32 bytes');
  return {
    seal(plaintext, context = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`;
    },
    open(sealed, context = '') {
      const [version, ivB64, tagB64, bodyB64] = String(sealed).split('.');
      if (version !== 'v1') throw new Error('unsupported vault format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

export const sha256 = value => createHash('sha256').update(value).digest('hex');
