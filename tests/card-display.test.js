import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardAuthor, galleryDisplay} from '../shared/card-display.js';

test('card authors use submitted names and preserve the exact email ID for legacy ideas',()=>{
  assert.equal(cardAuthor({full_name:'  Élodie O’Neil  ',author:'elodie.oneil@nepgroup.com'}),'Élodie O’Neil');
  for(const full_name of [null,undefined,'','  '])assert.equal(cardAuthor({full_name,author:'jane.smith@nepgroup.com'}),'jane.smith');
});

test('gallery sorting cannot retain a hidden metric, and both hidden removes sorting',()=>{
  assert.deepEqual(galleryDisplay({},'likes'),{showVotes:true,showLikes:true,showSort:true,sort:'likes'});
  for(const votes of [0,1])for(const likes of [0,1])for(const requested of ['newest','likes','votes']){
    const display=galleryDisplay({show_vote_counts:votes,show_like_counts:likes},requested);
    assert.equal(display.showSort,!!(votes||likes));
    assert.equal(display.sort,requested==='likes'&&!likes||requested==='votes'&&!votes?'newest':requested);
  }
});
