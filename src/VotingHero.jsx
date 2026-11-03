import React from 'react';
import { ArrowDown, ArrowUpRight, Check, Clock3, LockKeyhole, Sparkles, Vote } from 'lucide-react';

export const eventDate = value => value ? new Date(value).toLocaleString(undefined, { day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short' }) : '';

function BallotGraphic({closed}) {
  return <div className={`ballot-graphic ${closed?'is-closed':''}`} aria-hidden="true">
    <svg viewBox="0 0 420 340" fill="none">
      <ellipse cx="213" cy="294" rx="126" ry="17" fill="currentColor" opacity=".07"/>
      <circle cx="213" cy="165" r="128" stroke="currentColor" opacity=".13"/>
      <circle cx="213" cy="165" r="155" stroke="currentColor" opacity=".1" strokeDasharray="3 9"/>
      <path d="M112 185L206 149L316 184L224 225L112 185Z" fill={closed?'#E5D8C1':'#BFAAF4'} stroke="currentColor" strokeOpacity=".16"/>
      <path d="M112 185L224 225V288L112 246V185Z" fill={closed?'#F2EADB':'#E8DEFF'} stroke="currentColor" strokeOpacity=".12"/>
      <path d="M224 225L316 184V247L224 288V225Z" fill={closed?'#D5C5A7':'#A88BDD'} stroke="currentColor" strokeOpacity=".12"/>
      <path d="M165 186L212 168L262 185L217 204L165 186Z" fill={closed?'#947749':'#6440A6'}/>
      {!closed&&<g className="ballot-paper"><rect x="161" y="60" width="97" height="113" rx="10" transform="rotate(-12 161 60)" fill="white" stroke="#C9B7EA"/><circle cx="215" cy="107" r="21" fill="#F0E9FF"/><path d="M204 107L212 115L227 98" stroke="#7854BE" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/><path d="M188 147L238 136M190 156L224 149" stroke="#DED3F3" strokeWidth="4" strokeLinecap="round"/></g>}
      {closed&&<g><circle cx="217" cy="126" r="57" fill="#FAF5EB" stroke="#DCCAA6" strokeWidth="2"/><circle cx="217" cy="126" r="46" stroke="#DCCAA6" strokeDasharray="2 6"/><path d="M196 126L210 140L239 111" stroke="#AA8750" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/><path d="M187 175L180 209L202 202L216 219L221 183M229 181L242 211L251 194L272 194L251 173" fill="#E8DABF" stroke="#DCCAA6"/></g>}
      <path d="M79 96V116M69 106H89M333 134V152M324 143H342" stroke="currentColor" strokeWidth="2" opacity=".4" strokeLinecap="round"/>
      <path d="M318 65L323 78L336 83L323 88L318 101L313 88L300 83L313 78L318 65Z" fill={closed?'#D5BA80':'#BE9CDA'} opacity=".7"/>
      <circle cx="83" cy="217" r="5" fill="currentColor" opacity=".25"/><circle cx="279" cy="35" r="4" fill="currentColor" opacity=".25"/>
    </svg>
    <span className="graphic-chip">{closed?<Check size={15}/>:<Sparkles size={15}/>} {closed?'Every voice mattered':'Your voice. Our future.'}</span>
  </div>;
}

export function VotingHero({settings,now,votesAvailable}) {
  const open=settings.status==='open',upcoming=settings.status==='upcoming';
  const target=upcoming?settings.starts_at:settings.ends_at;
  const seconds=Math.max(0,Math.ceil((Date.parse(target)-now)/1000));
  const remaining=[Math.floor(seconds/86400),Math.floor(seconds%86400/3600),Math.floor(seconds%3600/60),seconds%60];
  const ended=!open&&!upcoming&&settings.ends_at&&Date.parse(settings.ends_at)<=now;
  return <section className={`voting-hero ${open?'voting-open':upcoming?'voting-upcoming':'voting-closed'}`} aria-labelledby="voting-title">
    <div className="voting-hero-copy">
      <div className="event-kicker"><span className="event-dot"/>{open?'IT’S TIME TO CHAMPION BRILLIANT IDEAS':upcoming?'THE NEXT CHAPTER IS ALMOST HERE':'GOOD IDEAS BRING US TOGETHER'}</div>
      <h1 id="voting-title">Voting <span>{open?'Open':upcoming?'Opens Soon':'Closed'}</span><span className="title-dot">.</span></h1>
      <p>{open?'A bold idea deserves a little backing. Explore the possibilities and help shape what comes next.':upcoming?'Meet the ideas. Find your favourites. Get ready to make your voice count.':ended?'Thank you for backing brighter possibilities. Keep exploring the ideas that could shape our future.':'The possibilities are here. Explore the ideas and give your favourites a little love while voting is closed.'}</p>
      {(open||upcoming)&&Number.isFinite(seconds)?<div className="hero-countdown" role="timer" aria-live="off" aria-label={`Voting ${upcoming?'starts':'ends'} in ${remaining[0]} days, ${remaining[1]} hours, ${remaining[2]} minutes, ${remaining[3]} seconds`}>
        <div className="countdown-label"><Clock3 size={14}/>{upcoming?'VOTING STARTS IN':'VOTING ENDS IN'}</div>
        <div className="countdown-digits">{remaining.map((value,index)=><div key={index}><strong>{String(value).padStart(2,'0')}</strong><span>{['DAYS','HOURS','MINS','SECS'][index]}</span></div>)}</div>
        <span className="event-date">{upcoming?'Opens':'Closes'} {eventDate(target)}</span>
      </div>:<div className="event-message">{open?<Clock3 size={18}/>:<LockKeyhole size={18}/>}<div><strong>{open?'Closing time to be announced':ended?'Every vote is part of our next chapter.':'Great thinking never stops.'}</strong><span>{ended?`Voting ended ${eventDate(settings.ends_at)}`:open?'The administrator can configure the closing date.':'Likes and ideas stay here for you to explore.'}</span></div></div>}
      <a className="event-cta" href="#ideas-gallery">{open?<Vote size={17}/>:<ArrowDown size={16}/>} {open?'Explore & vote':'Explore the ideas'}<ArrowUpRight size={17}/></a>
    </div>
    <BallotGraphic closed={!open}/>
    <div className="voting-hero-footer"><span><span className="event-dot"/>{open?`${votesAvailable} VOTE${votesAvailable===1?'':'S'} AVAILABLE TO YOU`:upcoming?'YOUR FAVOURITE IDEAS ARE WAITING':'ONE NEP. ENDLESS POSSIBILITIES.'}</span><span>INNOVATION WEEK · MADE POSSIBLE BY YOU</span></div>
  </section>;
}
