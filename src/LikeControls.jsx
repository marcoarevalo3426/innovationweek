import React, { useState } from 'react';
import { Check, Heart, LoaderCircle, RotateCcw } from 'lucide-react';
const localDate = value => value ? new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16) : '';

export default function LikeControls({settings,onSave,onReset}) {
  const [mode,setMode]=useState(settings.likes_mode??'open');
  const [start,setStart]=useState(localDate(settings.likes_starts_at));
  const [end,setEnd]=useState(localDate(settings.likes_ends_at));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const save=async event=>{
    event.preventDefault();
    const values=new FormData(event.currentTarget);
    const submittedStart=mode==='scheduled'?String(values.get('likes_starts_at')??''):start;
    const submittedEnd=['open','scheduled'].includes(mode)?String(values.get('likes_ends_at')??''):end;
    setStart(submittedStart);setEnd(submittedEnd);setBusy(true);setError('');
    try {
      await onSave({likes_mode:mode,likes_starts_at:submittedStart?new Date(submittedStart).toISOString():null,likes_ends_at:submittedEnd?new Date(submittedEnd).toISOString():null});
    } catch(error) {setError(error.message);} finally {setBusy(false);}
  };
  const status=settings.likes_status??'open';
  return <section className="like-controls" aria-label="Like schedule">
    <form className="admin-form" onSubmit={save}>
      <div className="admin-card">
        <div className="section-heading"><div><h2><Heart size={21}/> Likes, on your terms.</h2><p>Choose when everyone can like and unlike ideas.</p></div><span className={`status-pill ${status==='open'?'open':''}`}>{status==='open'?'Likes are open':status==='upcoming'?'Likes scheduled':'Likes closed'}</span></div>
        <div className="mode-options">{[['closed','Close likes','Freeze changes to existing likes.'],['open','Open likes now','Let everyone support their favourite ideas.'],['scheduled','Schedule likes','Choose a separate start and end.']].map(([id,label,description])=><label key={id} className={mode===id?'selected':''}><input type="radio" name="likes-mode" checked={mode===id} value={id} onChange={()=>setMode(id)}/><strong>{label}</strong><span>{description}</span></label>)}</div>
        {['open','scheduled'].includes(mode)&&<div className="schedule-fields">{mode==='scheduled'&&<div><label htmlFor="likes-start">Likes start</label><input id="likes-start" name="likes_starts_at" type="datetime-local" required defaultValue={start} onChange={e=>setStart(e.target.value)}/></div>}<div><label htmlFor="likes-end">Likes end {mode==='open'?'(optional)':''}</label><input id="likes-end" name="likes_ends_at" type="datetime-local" required={mode==='scheduled'} defaultValue={end} onChange={e=>setEnd(e.target.value)}/></div><p>Times are in your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. {mode==='open'?'Leave the end blank to keep likes open until you close them.':'Likes open at the start and close automatically at the end.'}</p></div>}
        <p className="info-note">Closing likes keeps existing selections and totals. New likes and unlikes are paused.</p>
        {error&&<p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="admin-save"><span>Like settings apply independently of voting.</span><button className="button" type="submit" disabled={busy}>{busy?<LoaderCircle size={17} className="spin"/>:<Check size={17}/>} Save like settings</button></div>
    </form>
    <div className="admin-card reset-card"><div><h2>A fresh start for likes.</h2><p>Clear all like totals and give every idea a fresh start.</p></div><button className="button danger-outline" type="button" onClick={onReset}><RotateCcw size={16}/> Reset all likes</button></div>
  </section>;
}
