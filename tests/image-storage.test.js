import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageStorage } from '../server/image-storage.js';

test('different API nodes share private S3 images and missing images return 404', async () => {
  const objects = new Map();
  const client = { async send(command) {
    const { Bucket, Key, Body, ContentType, ServerSideEncryption } = command.input;
    assert.equal(Bucket, 'private-test-bucket');
    if (command.constructor.name === 'PutObjectCommand') {
      assert.equal(ContentType, 'image/webp'); assert.equal(ServerSideEncryption, 'AES256');
      objects.set(Key, Buffer.from(Body));
    } else if (command.constructor.name === 'DeleteObjectCommand') objects.delete(Key);
    else {
      if (!objects.has(Key)) throw Object.assign(new Error('Missing'), {name:'NoSuchKey'});
      return {Body:{transformToByteArray:async()=>objects.get(Key)}};
    }
  }};
  const env={IMAGE_STORAGE:'s3',S3_UPLOAD_BUCKET:'private-test-bucket',AWS_REGION:'ap-southeast-2'};
  const first=createImageStorage(env,{client}),second=createImageStorage(env,{client});
  const name='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp';
  await first.put(name,Buffer.from('image bytes'));
  assert.equal((await second.get(name)).toString(),'image bytes');
  await second.remove(name);
  await assert.rejects(first.get(name),error=>error.status===404);
  await assert.rejects(first.get('../secret'),error=>error.status===404);
});

test('invalid image storage settings fail closed',()=>{
  assert.throws(()=>createImageStorage({IMAGE_STORAGE:'unknown'}));
  assert.throws(()=>createImageStorage({IMAGE_STORAGE:'s3',AWS_REGION:'ap-southeast-2'}));
  assert.throws(()=>createImageStorage({IMAGE_STORAGE:'s3',S3_UPLOAD_BUCKET:'bucket'}));
});
