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

export function PairCodeCard({ code, now, onNew, onDone, busy, level = 3 }: { code: PairCode; now: () => number; onNew: () => void; onDone?: () => void; busy?: boolean; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  const [t, setT] = useState(now());
  useEffect(() => { const i = setInterval(() => setT(now()), 1000); return () => clearInterval(i); }, [now]);
  const left = timeLeft(code.expiresAt, t);
  const expired = left === 'expired';
  const pairPage = code.pairUrl.replace(/#.*$/, '');
  return (
    <div className="card paircard" role="group" aria-labelledby="pair-h">
      <H id="pair-h" className="pairtitle">Pair your phone</H>
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
