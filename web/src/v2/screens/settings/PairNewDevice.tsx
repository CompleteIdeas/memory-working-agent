/**
 * "Pair a new device" (v2 build, slice W5): a one-time code from the server, shown as a QR of the pairing link and as
 * text to type, good for 10 minutes and one device. Used in Settings › Devices and at the end of first run.
 * The QR is drawn here (./qr.ts), dark on a light square in both themes so any camera reads it.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PairCode } from '../../api/client';
import { encodeQr, qrSvgPath } from './qr';

export function QrImage({ text, label, size = 220 }: { text: string; label: string; size?: number }) {
  const svg = useMemo(() => { try { return qrSvgPath(encodeQr(text)); } catch { return null; } }, [text]);
  if (!svg) return <p className="soft">The link is too long for a QR code. Type the code instead.</p>;
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={svg.viewBox} width={size} height={size} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#ffffff" />
      <path d={svg.d} fill="#000000" />
    </svg>
  );
}

/** Minutes and seconds left, "9:41"; "expired" at 0. */
export function timeLeft(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'expired';
}

export function PairCodeCard({ code, now, onNew, onDone, busy, level = 3, onSetAddress }: {
  code: PairCode; now: () => number; onNew: () => void; onDone?: () => void; busy?: boolean; level?: 2 | 3;
  /** the link says "localhost" (no public address known): save the helper's address, then make a new code */
  onSetAddress?: (url: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const H = level === 2 ? 'h2' : 'h3';
  const [t, setT] = useState(now());
  useEffect(() => { const i = setInterval(() => setT(now()), 1000); return () => clearInterval(i); }, [now]);
  const left = timeLeft(code.expiresAt, t);
  const expired = left === 'expired';
  const pairPage = code.pairUrl.replace(/#.*$/, '');
  return (
    <div className="card paircard" role="group" aria-labelledby="pair-h">
      <H id="pair-h" className="pairtitle">Pair your phone</H>
      {code.reachable === false && <AddressAsk onSave={onSetAddress} />}
      {expired ? (
        <p className="soft">This code has expired. Make a new one.</p>
      ) : (
        <>
          <p>On your phone, open the camera and point it at this code. Then tap Pair.</p>
          <div className="qrwrap"><QrImage text={code.pairUrl} label={`Pairing code ${code.code}, as a QR code`} /></div>
          <p className="soft">Or open <span className="addrmono">{pairPage.replace(/^https?:\/\//, '')}</span> on the phone and type</p>
          <p className="paircode">{code.code}</p>
          <p className="soft">Good for one phone, for {left} more.</p>
        </>
      )}
      <div className="acts">
        {expired && <button type="button" className="vbtn vbtn-primary" onClick={onNew} disabled={busy}>Make a new code</button>}
        {!expired && <button type="button" className="vbtn" onClick={onNew} disabled={busy}>Make a new code</button>}
        {onDone && <button type="button" className="vbtn vbtn-quiet" onClick={onDone}>Done</button>}
      </div>
    </div>
  );
}

/** "Your phone can't reach localhost": ask for the helper's address (the one the phone opens over Tailscale). */
function AddressAsk({ onSave }: { onSave?: (url: string) => Promise<{ ok: boolean; message?: string }> }) {
  const [v, setV] = useState('');
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="addrask" role="alert">
      <p><b>Your phone can’t reach “localhost”.</b> Set your helper’s address — the one your phone opens, for example https://mwa.tail1a2b.ts.net — and make a new code.</p>
      {onSave && (
        <form className="dollarrow" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setNote(null);
          const r = await onSave(v);
          setNote(r.ok ? null : { text: r.message ?? 'That didn’t work.', error: true });
          setBusy(false);
        }}>
          <label htmlFor="pair-addr" className="sr-only">Your helper’s address</label>
          <input id="pair-addr" className="setinput" inputMode="url" placeholder="https://mwa.tail1a2b.ts.net" value={v} onChange={(e) => setV(e.target.value)} />
          <button type="submit" className="vbtn" disabled={busy || !v.trim()}>Save</button>
        </form>
      )}
      {note && <p className="setnote error">{note.text}</p>}
    </div>
  );
}
