/**
 * Settings › Notifications (v2 build, slice P3): turn notifications on or off for THIS device (the permission is
 * asked only on the tap), which kinds, the morning check-in time, quiet hours, "Send a test", and this device's state
 * in plain words (on / off / blocked with how to unblock / needs install on iPhone / needs the secure address / not
 * supported). Notifications go through Google's or Apple's push service, so they never carry a title or a message:
 * only a kind, and the app fetches the rest when it opens.
 */
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store/react';
import type { PushKindName, PushList, PushSettings } from '../../api/client';
import { askPermission, browserSubscription, platformName, pushState, pushWords, readFacts, subscribeBrowser, unsubscribeBrowser } from '../../../pwa/push';
import { secureAddress } from '../../../pwa/install';
import { messageOf } from './useSettings';

const KIND_LABEL: Record<PushKindName, string> = {
  approval: 'Something needs your OK',
  waiting: 'A job is waiting for you',
  result: 'A result is ready',
  morning: 'Your morning check-in',
};
const KINDS: PushKindName[] = ['approval', 'waiting', 'result', 'morning'];
type Said = { text: string; error: boolean } | null;

export function NotificationsCard({ publicUrl = null }: { publicUrl?: string | null }) {
  const client = useStore().client;
  const [list, setList] = useState<PushList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);

  const load = useCallback(async () => {
    try {
      const [l, sub] = await Promise.all([client.listPushSubscriptions(), browserSubscription()]);
      let got = l;
      // the browser still has a subscription the server no longer knows (pruned, or this phone paired again): give it
      // back quietly — only when notifications are already allowed, so nothing is ever asked here
      if (sub && Notification.permission === 'granted' && !l.subscriptions.some((s) => s.mine && s.endpoint === sub.endpoint)) {
        const j = sub.toJSON();
        if (j.endpoint && j.keys?.p256dh && j.keys.auth) {
          try {
            await client.addPushSubscription({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, expirationTime: j.expirationTime ?? null, platform: platformName(navigator.userAgent, navigator.maxTouchPoints) });
            got = await client.listPushSubscriptions();
          } catch { /* shown as off */ }
        }
      }
      setList(got); setEndpoint(sub?.endpoint ?? null); setLoadError(null);
    } catch (e) { setLoadError(messageOf(e)); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const mine = list?.subscriptions.find((s) => s.mine && s.endpoint === endpoint) ?? null;
  const facts = readFacts(!!mine);
  const state = pushState(facts);
  const words = pushWords(state, facts, secureAddress(publicUrl));

  const turnOn = () => {
    if (!list) return;
    setSaid(null); setBusy(true);
    const permission = askPermission(); // first, inside the tap (iPhone asks only from the gesture)
    void (async () => {
      try {
        const r = await subscribeBrowser(permission, list.vapidPublicKey);
        if (!r.ok) { setSaid({ text: r.message, error: true }); return; }
        const j = r.subscription;
        await client.addPushSubscription({ endpoint: j.endpoint!, keys: { p256dh: j.keys!.p256dh, auth: j.keys!.auth }, expirationTime: j.expirationTime ?? null, platform: platformName(navigator.userAgent, navigator.maxTouchPoints) });
        setSaid({ text: 'Notifications are on for this device.', error: false });
      } catch (e) { setSaid({ text: messageOf(e), error: true }); }
      finally { setBusy(false); await load(); }
    })();
  };
  const turnOff = async () => {
    setSaid(null); setBusy(true);
    try {
      if (mine) await client.removePushSubscription(mine.id);
      await unsubscribeBrowser();
      setSaid({ text: 'Notifications are off for this device.', error: false });
    } catch (e) { setSaid({ text: messageOf(e), error: true }); }
    finally { setBusy(false); await load(); }
  };
  const test = async () => {
    setSaid(null); setBusy(true);
    try { const r = await client.sendPushTest(); setSaid({ text: r.message, error: !r.accepted }); }
    catch (e) { setSaid({ text: messageOf(e), error: true }); }
    finally { setBusy(false); await load(); }
  };
  const save = async (patch: Parameters<typeof client.updatePushSettings>[0], ok: string) => {
    setSaid(null);
    try {
      const s = await client.updatePushSettings(patch);
      setList((l) => (l ? { ...l, settings: s } : l));
      setSaid({ text: ok, error: false });
    } catch (e) { setSaid({ text: messageOf(e), error: true }); }
  };

  if (loadError) {
    return <div className="card setcard" id="notify-card"><p className="soft">{loadError}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void load()}>Try again</button></div></div>;
  }
  if (!list) return <div className="card setcard" id="notify-card"><p className="soft">Loading…</p></div>;
  const others = list.subscriptions.filter((s) => !(s.mine && s.endpoint === endpoint)).length;
  return (
    <div className="card setcard" id="notify-card">
      <div className="setrow">
        <div className="grow">
          <span className="rowtitle" id="notify-device">This device{state === 'on' && <span className="okmark"> · on</span>}</span>
          <span className={words.tone === 'warn' ? 's warnline' : 's'} id="notify-state" data-state={state}>{words.line}</span>
        </div>
        {words.button && (
          <button type="button" className={state === 'on' ? 'vbtn' : 'vbtn vbtn-primary'} disabled={busy} aria-describedby="notify-device"
            onClick={() => (state === 'on' ? void turnOff() : turnOn())}>
            {busy ? 'One moment…' : words.button}
          </button>
        )}
      </div>
      {others > 0 && <p className="s soft">Also on for {others === 1 ? 'one other device' : `${others} other devices`}.</p>}
      {state === 'on' && <div className="acts"><button type="button" className="vbtn" disabled={busy} onClick={() => void test()}>Send a test</button></div>}

      <fieldset className="notifykinds">
        <legend className="rowtitle">Tell me when</legend>
        {KINDS.map((k) => (
          <label key={k} className="checkrow">
            <input type="checkbox" checked={list.settings.kinds[k]} onChange={(e) => void save({ kinds: { [k]: e.target.checked } }, e.target.checked ? `I’ll tell you: ${KIND_LABEL[k].toLowerCase()}.` : `I won’t notify for: ${KIND_LABEL[k].toLowerCase()}.`)} />
            {' '}{KIND_LABEL[k]}
          </label>
        ))}
      </fieldset>
      <MorningTime settings={list.settings} save={save} />
      <QuietHours settings={list.settings} save={save} />
      <p className="s soft" id="notify-privacy">
        Notifications pass through Google’s or Apple’s push service; they never contain your messages or titles. They only say
        something like “Something needs your OK”, and the app shows the details once you open it.
      </p>
      {said && <p className={said.error ? 'setnote error' : 'setnote'} role={said.error ? 'alert' : 'status'}>{said.text}</p>}
    </div>
  );
}

function MorningTime({ settings, save }: { settings: PushSettings; save: (p: { morning: string }, ok: string) => Promise<void> }) {
  const [v, setV] = useState(settings.morning);
  useEffect(() => setV(settings.morning), [settings.morning]);
  return (
    <div className="setrow">
      <label className="grow" htmlFor="notify-morning"><span className="rowtitle">Morning check-in at</span><span className="s">Only when there’s something to say ({settings.timeZone}).</span></label>
      <input id="notify-morning" type="time" min="05:00" max="11:30" value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v && v !== settings.morning) void save({ morning: v }, `Your morning check-in comes at ${v}.`); }} />
    </div>
  );
}

function QuietHours({ settings, save }: { settings: PushSettings; save: (p: { quietHours: string | null }, ok: string) => Promise<void> }) {
  const q = settings.quietHours;
  const [from, to] = (q.value ?? '22:00-07:00').split('-');
  const [on, setOn] = useState(!!q.value);
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  useEffect(() => { setOn(!!q.value); const [x, y] = (q.value ?? '22:00-07:00').split('-'); setA(x); setB(y); }, [q.value]);
  if (q.fixed) return <p className="s">Quiet hours: {q.value ?? 'none'} (set when this helper was installed).</p>;
  return (
    <fieldset className="notifyquiet">
      <legend className="rowtitle">Quiet hours</legend>
      <label className="checkrow"><input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); if (!e.target.checked && q.value) void save({ quietHours: null }, 'Quiet hours are off.'); }} /> Hold notifications at night</label>
      {on && (
        <div className="setrow">
          <label htmlFor="quiet-from">From</label> <input id="quiet-from" type="time" value={a} onChange={(e) => setA(e.target.value)} />
          <label htmlFor="quiet-to">to</label> <input id="quiet-to" type="time" value={b} onChange={(e) => setB(e.target.value)} />
          <button type="button" className="vbtn" onClick={() => void save({ quietHours: `${a}-${b}` }, `Quiet from ${a} to ${b}. What needs you then waits until ${b}.`)}>Save</button>
        </div>
      )}
      <p className="s soft">The same quiet hours apply to Telegram. Times are on the helper’s computer clock.</p>
    </fieldset>
  );
}
