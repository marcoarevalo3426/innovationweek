import React, { useState } from 'react';
import { Check, LoaderCircle, LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { eventDate } from './VotingHero.jsx';
const toLocal=value=>value?new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
export default function SubmissionControls({settings,onSave}) {
  const [mode,setMode]=useState(settings.submission_mode),[end,setEnd]=useState(toLocal(settings.submission_ends_at)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const persist=async(payload)=>{setBusy(true);setError('');try{await onSave(payload);setMode(payload.submission_mode);if(payload.submission_ends_at!==undefined)setEnd(toLocal(payload.submission_ends_at));}catch(e){setError(e.message);}finally{setBusy(false);}};
  const submit=e=>{e.preventDefault();const value=new FormData(e.currentTarget).get('submission_ends_at');persist({submission_mode:mode,submission_ends_at:mode==='scheduled'&&value?new Date(value).toISOString():settings.submission_ends_at});};
  const open=settings.submission_status==='open';
  return <form className="admin-form" onSubmit={submit}>
    <div className="admin-card"><div className="section-heading"><div><h2>Give every idea its moment.</h2><p>Choose when new ideas can join Innovation Week.</p></div><span className={`status-pill ${open?'open':''}`}>{open?'Submissions open':'Submissions closed'}</span></div>
      <div className="mode-options">{[['open','Accept ideas','Keep new submissions open.'],['scheduled','Schedule a deadline','Automatically close at a date and time.'],['closed','Stop submissions','Close submissions immediately when saved.']].map(([value,label,description])=><label key={value} className={mode===value?'selected':''}><input type="radio" name="submission-mode" checked={mode===value} value={value} onChange={()=>setMode(value)}/><strong>{label}</strong><span>{description}</span></label>)}</div>
      {mode==='scheduled'&&<div className="schedule-fields submission-schedule"><div><label htmlFor="submission-ends">Idea submissions close</label><input id="submission-ends" name="submission_ends_at" type="datetime-local" required value={end} onChange={e=>setEnd(e.target.value)}/></div><p>Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. New submissions stop at this exact time, including forms already open.</p></div>}
      <p className="info-note"><LockKeyhole size={16}/> Closing submissions blocks new ideas for everyone, including administrators. Existing ideas can still be edited or deleted. Voting and likes have their own controls.</p>
      {settings.submission_mode==='scheduled'&&<p className="submission-current">Current deadline: {eventDate(settings.submission_ends_at)}</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="admin-card reset-card"><div><h2>{open?'Need to close the door now?':'Ready for more bright ideas?'}</h2><p>{open?'Stop new submissions now, even if a later deadline is scheduled.':'Reopen submissions without changing voting or existing ideas.'}</p></div><button className={`button ${open?'danger-outline':'secondary'}`} type="button" disabled={busy} onClick={()=>persist({submission_mode:open?'closed':'open'})}>{open?<LockKeyhole size={16}/>:<UnlockKeyhole size={16}/>} {open?'Stop submissions now':'Reopen submissions now'}</button></div>
    <div className="admin-save"><span>Saved changes apply to everyone.</span><button className="button" type="submit" disabled={busy}>{busy?<LoaderCircle className="spin" size={17}/>:<Check size={17}/>} Save submission settings</button></div>
  </form>;
}
