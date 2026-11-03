import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export function createImageStorage(env = process.env, { client } = {}) {
  const mode = env.IMAGE_STORAGE || 'local';
  if (!['local', 's3'].includes(mode)) throw new Error('IMAGE_STORAGE must be local or s3.');
  const bucket = env.S3_UPLOAD_BUCKET;
  const prefix = env.S3_UPLOAD_PREFIX || 'uploads/';
  if (mode === 's3' && (!bucket || !(env.AWS_REGION || env.AWS_DEFAULT_REGION))) throw new Error('S3 image storage requires S3_UPLOAD_BUCKET and AWS_REGION.');
  if (!/^[a-zA-Z0-9/_-]+\/$/.test(prefix) || prefix.includes('..')) throw new Error('Invalid S3_UPLOAD_PREFIX.');
  const directory = resolve(env.DATA_DIR || './data', 'uploads');
  const s3 = mode === 's3' ? client || new S3Client({ region: env.AWS_REGION || env.AWS_DEFAULT_REGION, maxAttempts: 3, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 } }) : null;
  function key(name) {
    if (!/^[a-f0-9-]+\.webp$/.test(name)) throw Object.assign(new Error('Image not found.'), { status: 404 });
    return prefix + name;
  }
  return {
    mode,
    async put(name, bytes) {
      const objectKey = key(name);
      if (s3) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: 'image/webp', ServerSideEncryption: 'AES256' }));
      else { await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, name), bytes, { mode: 0o600 }); }
    },
    async get(name) {
      const objectKey = key(name);
      try {
        if (!s3) return await readFile(resolve(directory, name));
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        if (!object.Body) throw new Error('Image response has no body.');
        return Buffer.from(await object.Body.transformToByteArray());
      } catch (error) {
        if (error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw Object.assign(new Error('Image not found.'), { status: 404 });
        throw error;
      }
    },
    async remove(name) {
      const objectKey = key(name);
      if (s3) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      else { try { await unlink(resolve(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    },
  };
}
