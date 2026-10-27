/**
 * Settings › This device › "Install on this phone" (v2 build, slice P1). The browser's own Install where it offers
 * one (Chrome, Edge, Samsung Internet), Share › Add to Home Screen on iPhone Safari, and — on an address the phone
 * won't install from (http://100.x…) — the secure address to open instead. The words are in src/pwa/install.ts.
 *
 * Shown in W5's Settings (screens/settings/Settings.tsx), section "This device"; `publicUrl` is Settings › Your helper ›
 * Address for phones (MWA_PUBLIC_URL).
 */
import { useState } from 'react';
import { useInstallState } from '../../../pwa/react';
import { promptInstall } from '../../../pwa/register';
import { installAdvice, installWay } from '../../../pwa/install';

export function InstallCard({ publicUrl = null }: { publicUrl?: string | null } = {}) {
  const { canPrompt, standalone, justInstalled } = useInstallState();
  const [note, setNote] = useState<string | null>(null);
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  const way = justInstalled ? 'installed' : installWay({
    secure, standalone, canPrompt,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    touchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  });
  const a = installAdvice(way, publicUrl);
  const install = async () => {
    setNote(null);
    const r = await promptInstall();
    if (r === 'accepted') setNote('Installed. Open MWA from your home screen.');
    else if (r === 'dismissed') setNote('Not installed. You can install it here any time.');
    else setNote('Your browser didn’t offer to install just now. Use its menu: Install app.');
  };
  return (
    <div className="card installcard" id="install-card">
      <h3 className="t" style={{ fontSize: 17 }}>{a.title}</h3>
      {way === 'ios-safari' ? (
        <ol>{a.lines.map((l) => <li key={l}>{l}</li>)}</ol>
      ) : (
        a.lines.map((l) => <p key={l} className="s" style={{ marginTop: 6 }}>{l}</p>)
      )}
      {a.button && (
        <div className="acts"><button type="button" className="vbtn vbtn-primary" onClick={() => void install()}>{a.button}</button></div>
      )}
      {note && <p role="status" className="s" style={{ marginTop: 8 }}>{note}</p>}
    </div>
  );
}
