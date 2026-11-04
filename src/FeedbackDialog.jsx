import React, {useState} from 'react';
import {CheckCircle2, LoaderCircle, Send} from 'lucide-react';
import {api} from './api-client.js';

export default function FeedbackDialog({Modal,email,onClose}) {
  const [website,setWebsite]=useState(''),[general,setGeneral]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[submitted,setSubmitted]=useState(false);
  const hasFeedback=!!(website.trim()||general.trim());
  const submit=async event=>{
    event.preventDefault();if(busy||!hasFeedback)return;
    setBusy(true);setError('');
    try {
      const body={};if(website.trim())body.website=website.trim();if(general.trim())body.general=general.trim();
      await api('/feedback',{method:'POST',body});setSubmitted(true);
    } catch(error){setError(error.message);} finally{setBusy(false);}
  };
  if(submitted)return <Modal title="Thank you for your feedback!" onClose={onClose} className="feedback-confirmation"><div className="feedback-thanks" role="status"><CheckCircle2 size={56}/><h2>You’re helping us make it better.</h2><p>Thank you for sharing your thoughts. Your feedback will help improve the website and our next Innovation Week.</p><button className="button" onClick={onClose}>Done</button></div></Modal>;
  return <Modal title="Share your feedback" onClose={()=>!busy&&onClose()} wide explicitCloseOnly><form className="feedback-form" onSubmit={submit}>
    <p className="form-intro">We’d love to hear from you. Complete either field, or both.</p>
    <section><h3>Help us improve this website</h3><p id="website-feedback-caption">Was anything confusing or difficult to use? Tell us about bugs, suggest improvements or share features you’d like to see. Your ideas will help make the website easier and more enjoyable for everyone.</p><label htmlFor="website-feedback">Website feedback <span>(optional)</span></label><textarea id="website-feedback" aria-describedby="website-feedback-caption" maxLength={4000} rows={4} value={website} onChange={e=>setWebsite(e.target.value)} disabled={busy}/><span className="field-count">{website.length}/4000</span></section>
    <section><h3>Help shape our next Innovation Week</h3><p id="general-feedback-caption">What worked well, and what could be better? Share your thoughts on the activities, communication and overall experience. Your feedback will help make the next Innovation Week even better.</p><label htmlFor="general-feedback">Innovation Week feedback <span>(optional)</span></label><textarea id="general-feedback" aria-describedby="general-feedback-caption" maxLength={4000} rows={4} value={general} onChange={e=>setGeneral(e.target.value)} disabled={busy}/><span className="field-count">{general.length}/4000</span></section>
    <p className="feedback-email">Submitting as <strong>{email}</strong></p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="feedback-form-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button" type="submit" disabled={busy||!hasFeedback}>{busy?<LoaderCircle size={17} className="spin"/>:<Send size={17}/>} Submit feedback</button></div>
  </form></Modal>;
}
