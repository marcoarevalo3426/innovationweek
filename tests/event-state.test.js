import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVotingStatus, getSubmissionStatus, getHomepageHero, getLikeStatus } from '../shared/event-state.js';

test('voting closes at the exact deadline, for immediate and scheduled opening',()=>{
  const start=Date.parse('2026-11-01T00:00:00Z'),end=start+10000;
  const settings={mode:'scheduled',starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString()};
  assert.equal(getVotingStatus(settings,start-1),'upcoming');
  assert.equal(getVotingStatus(settings,start),'open');
  assert.equal(getVotingStatus(settings,end-1),'open');
  assert.equal(getVotingStatus(settings,end),'closed');
  assert.equal(getVotingStatus({...settings,mode:'open'},end-1),'open');
  assert.equal(getVotingStatus({...settings,mode:'open'},end),'closed');
  assert.equal(getVotingStatus({...settings,mode:'closed'},start),'closed');
});

test('welcome is on by default only before voting, and the admin can disable it',()=>{
  const now=Date.parse('2026-11-01T00:00:00Z');
  assert.equal(getHomepageHero({mode:'closed',show_welcome:1},now),'welcome');
  assert.equal(getHomepageHero({mode:'closed',show_welcome:0},now),'voting');
  const scheduled={mode:'scheduled',show_welcome:1,starts_at:new Date(now+1000).toISOString(),ends_at:new Date(now+2000).toISOString()};
  assert.equal(getHomepageHero(scheduled,now),'welcome');
  assert.equal(getHomepageHero({...scheduled,show_welcome:0},now),'voting');
  assert.equal(getHomepageHero(scheduled,now+1000),'voting');
  assert.equal(getHomepageHero(scheduled,now+2000),'voting');
  assert.equal(getHomepageHero({mode:'open',show_welcome:1,ends_at:new Date(now+2000).toISOString()},now),'voting');
  assert.equal(getHomepageHero({mode:'open',show_welcome:1,ends_at:new Date(now-1).toISOString()},now),'voting');
  assert.equal(getHomepageHero({mode:'closed',show_welcome:1,voting_started_at:new Date(now-1000).toISOString()},now),'voting');
});

test('submission closure is independent of voting and applies at the exact deadline',()=>{
  const end=Date.parse('2026-11-01T00:00:00Z');
  for(const mode of ['open','closed','scheduled']){
    const settings={mode,submission_mode:'scheduled',submission_ends_at:new Date(end).toISOString()};
    assert.equal(getSubmissionStatus(settings,end-1),'open');
    assert.equal(getSubmissionStatus(settings,end),'closed');
    assert.equal(getSubmissionStatus({...settings,submission_mode:'open'},end+1),'open');
    assert.equal(getSubmissionStatus({...settings,submission_mode:'closed'},end-1),'closed');
  }
  assert.equal(getSubmissionStatus({submission_mode:'scheduled',submission_ends_at:null},end),'closed');
});



test('likes have independent open/closed status and exact scheduled boundaries',()=>{
 const start=Date.parse('2026-11-01T00:00:00Z'),end=start+10000;
 const s={likes_mode:'scheduled',likes_starts_at:new Date(start).toISOString(),likes_ends_at:new Date(end).toISOString(),mode:'closed'};
 assert.equal(getLikeStatus({},start),'open');
 assert.equal(getLikeStatus(s,start-1),'upcoming');assert.equal(getLikeStatus(s,start),'open');assert.equal(getLikeStatus(s,end-1),'open');assert.equal(getLikeStatus(s,end),'closed');
 assert.equal(getLikeStatus({...s,likes_mode:'closed'},start),'closed');
 assert.equal(getLikeStatus({...s,likes_mode:'open'},end),'closed');assert.equal(getLikeStatus({...s,likes_mode:'open',likes_ends_at:null},end),'open');
 assert.equal(getLikeStatus({...s,likes_ends_at:s.likes_starts_at},start),'closed');assert.equal(getLikeStatus({...s,likes_starts_at:'invalid'},start),'closed');
 assert.equal(getVotingStatus(s,start),'closed');
});
