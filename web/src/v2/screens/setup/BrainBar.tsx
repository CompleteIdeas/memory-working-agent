/**
 * Without a working AI brain the helper can't answer, sort mail or do jobs (v2 build, slice S6): every screen says so
 * plainly, under the top bar, until one is set up. On this computer it opens Settings › Your assistant; a paired phone
 * is told where to set it up. Read once per page and again whenever the screen changes (GET /setup, read).
 */
import { useEffect, useState } from 'react';
import type { BrainState } from '../../api/client';
import { useMeta, useStore } from '../../store/react';
import { brainBar } from './words';
import './setup.css';

export function BrainBar({ view, onFix }: { view: string; onFix: () => void }) {
  const store = useStore();
  const { meta, auth } = useMeta();
  const [brain, setBrain] = useState<BrainState | null>(null);
  const [admin, setAdmin] = useState(false);
  const has = !!meta?.features.includes('setup');
  useEffect(() => {
    if (!has || auth !== 'ok') return;
    let live = true;
    Promise.all([store.client.getSetup(), store.client.getMe()]).then(([s, m]) => { if (live) { setBrain(s.brain); setAdmin(m.scopes.includes('admin')); } }).catch(() => { /* say nothing */ });
    return () => { live = false; };
  }, [store, has, auth, view]);
  const w = brainBar(brain, admin);
  if (!w) return null;
  return (
    <div className="brainbar" role="status" id="brainbar">
      <p>{w.text}</p>
      {w.action && view !== 'assistant' && <button type="button" className="vbtn" onClick={onFix}>{w.action}</button>}
    </div>
  );
}
