import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNepEmail, normalizeEmail } from '../shared/email-policy.js';

test('any valid colleague address is eligible, independent of administrator membership', () => {
  for (const email of ['new.colleague@nepgroup.com', 'first-last@nepgroup.com', 'first+ideas@nepgroup.com', "o'connor@nepgroup.com", '  New.Colleague@NEPGROUP.COM  ']) {
    assert.equal(isNepEmail(email), true, email);
  }
  assert.equal(normalizeEmail(' New.Colleague@NEPGROUP.COM '), 'new.colleague@nepgroup.com');
});

test('the shared login policy rejects other domains, lookalikes and malformed addresses', () => {
  for (const email of ['person@gmail.com', 'person@sub.nepgroup.com', 'person@nepgroup.com.evil.com', 'person@nepgrou.com', 'person@nepgroup.com@evil.com', 'name <person@nepgroup.com>', 'a..b@nepgroup.com', '.name@nepgroup.com', 'name.@nepgroup.com', 'a b@nepgroup.com', '\n@nepgroup.com', null, {}, 123, 'a'.repeat(242) + '@nepgroup.com']) {
    assert.equal(isNepEmail(email), false, String(email));
  }
});
