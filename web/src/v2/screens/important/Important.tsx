/**
 * The Important screen ("Worth a look", v2 build, slice W3), as approved (prototype-v2, SCENARIOS N03/N10/N11): an
 * ongoing list of what matters from every source, grouped Today / This week / Earlier, newest first.
 *
 *   - each item: source mark, who (with the address on anything from outside), time, title, one line on why, and at
 *     most one action; a phishing item in the caution style with only Open and Not important;
 *   - Handled (swipe left, or open it → Mark handled): it leaves at once, "Marked handled: … · Undo", and collects
 *     under a collapsed "Handled · N", each with Undo;
 *   - Not important: a small sheet (this sender / domain / kind — only what the server allows);
 *   - under each group: "I skipped 5 others today: newsletters, receipts, promotions · Show them";
 *   - how sorting is going ("3 messages are waiting to be sorted", "Older mail … wasn't sorted yet");
 *   - an email opens in the reader (the screen on a phone, the right-hand pane on a desktop); anything else opens a
 *     sheet that shows it in place; both have Ask about this, answered under the item;
 *   - "All email" keeps the plain mailbox one tap away; "Your rules" (until Settings, W5) lists what was taught.
 *
 * Today's "Worth a look" is the same list (the top 3 on a phone, with See all), through ImportantBody.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ImportantGroup, ImportantItem, ItemActionResult } from '../../api/client';
import { useItemActions, useItems, useMeta, useNow } from '../../store/react';
import { skipLine } from '../../store/important';
import { Sheet } from '../../shell/sheets';
import { Chev } from '../../shell/icons';
import type { ScreenProps, View } from '../../shell/screens';
import { AllEmail } from '../mail/AllEmail';
import { MailReader } from '../mail/Reader';
import { ItemDetailSheet } from './ItemDetail';
import { ItemRow } from './ItemRow';
import { useNotImportant } from './NotImportant';
import { RulesSheet } from './RulesSheet';
import { SkippedSheet } from './SkippedSheet';
import { CheckIcon } from './icons';
import './important.css';

interface ImportantUi {
  open: (it: ImportantItem) => void;
  handled: (it: ImportantItem) => void;
  notImportant: (it: ImportantItem) => void;
  run: (it: ImportantItem) => void;
  busy: (it: ImportantItem) => boolean;
  swiped: string | null;
  swipe: (id: string | null) => void;
  showSkipped: (g: ImportantGroup) => void;
  showRules: () => void;
}
const Ctx = createContext<ImportantUi | null>(null);
function useUi(): ImportantUi {
  const u = useContext(Ctx);
  if (!u) throw new Error('Important list outside ImportantProvider');
  return u;
}

/**
 * Everything the list's taps open: the item sheet, Not important, Show them, Your rules, and — where the screen has
 * no reader of its own (Today) — the reader in a sheet. `openMail` is the screen's reader; `onGone` is told when an
 * item leaves (handled, not important) so the screen can close it.
 */
function ImportantProvider({ children, go, openMail, onGone }: {
  children: ReactNode; go?: (v: View) => void; openMail?: (mailId: string, item: ImportantItem | null) => void; onGone?: (it: ImportantItem) => void;
}) {
  const items = useItems();
  const actions = useItemActions();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [askWith, setAskWith] = useState<string | null>(null);
  const [skipGroup, setSkipGroup] = useState<ImportantGroup | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [sheetMail, setSheetMail] = useState<{ mailId: string; itemId: string | null } | null>(null);
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [swiped, setSwiped] = useState<string | null>(null);

  const gone = useCallback((it: ImportantItem) => {
    setSwiped(null);
    setDetailId((d) => (d === it.id ? null : d));
    setSheetMail((m) => (m?.itemId === it.id ? null : m));
    onGone?.(it);
  }, [onGone]);
  const ni = useNotImportant(gone);

  const openMailHere = useCallback((mailId: string, item: ImportantItem | null) => {
    if (openMail) openMail(mailId, item); else setSheetMail({ mailId, itemId: item?.id ?? null });
  }, [openMail]);

  const run = useCallback(async (it: ImportantItem) => {
    setRunning((s) => new Set(s).add(it.id));
    const r = await actions.run(it);
    setRunning((s) => { const n = new Set(s); n.delete(it.id); return n; });
    if (!r.ok) return; // refused: the store said so; offline: it waits in the outbox
    const d = r.data as ItemActionResult;
    if (d.done) { actions.notice(d.message); return; }
    const route = (d.route ?? { view: 'mail' }) as { view: string; mailId?: string; item?: string };
    if (route.view === 'mail') { const id = route.mailId || it.mailId; if (id) openMailHere(id, it); return; }
    if (route.view === 'ask') { setDetailId(it.id); setAskWith('Draft a note asking to move one of them'); return; }
    if (route.view === 'settings' && go) { go('settings'); return; }
    actions.notice(d.message);
  }, [actions, go, openMailHere]);

  const ui = useMemo<ImportantUi>(() => ({
    open: (it) => { setSwiped(null); if (it.mailId) openMailHere(it.mailId, it); else { setAskWith(null); setDetailId(it.id); } },
    handled: (it) => { gone(it); void actions.handled(it); },
    notImportant: (it) => { setSwiped(null); ni.request(it); },
    run: (it) => { void run(it); },
    busy: (it) => running.has(it.id),
    swiped, swipe: setSwiped,
    showSkipped: (g) => setSkipGroup(g),
    showRules: () => setRulesOpen(true),
  }), [actions, gone, ni, openMailHere, run, running, swiped]);

  // a swiped row goes back when the person taps anywhere else
  useEffect(() => {
    if (!swiped) return;
    const off = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('.swipetray')) setSwiped(null); };
    const t = setTimeout(() => document.addEventListener('pointerdown', off), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', off); };
  }, [swiped]);

  const detail = detailId ? items.byId[detailId] ?? null : null;
  const mailItem = sheetMail?.itemId ? items.byId[sheetMail.itemId] ?? null : null;
  return (
    <Ctx.Provider value={ui}>
      {children}
      <ItemDetailSheet item={detail} askWith={askWith} onClose={() => { setDetailId(null); setAskWith(null); }}
        controls={{ handled: ui.handled, notImportant: ui.notImportant, run: ui.run, busy: ui.busy, openCalendar: go ? () => { setDetailId(null); go('calendar'); } : undefined }} />
      {ni.sheet}
      <SkippedSheet group={skipGroup} onClose={() => setSkipGroup(null)} />
      <RulesSheet open={rulesOpen} onClose={() => setRulesOpen(false)}
        onOpenSettings={go ? () => { setRulesOpen(false); history.replaceState(null, '', `${location.pathname}${location.search}#rules`); go('settings'); } : undefined} />
      {!openMail && (
        <Sheet id="mail-dlg" titleId="mail-dlg-title" title={<span className="sr-only">Email</span>} open={!!sheetMail} onClose={() => setSheetMail(null)}>
          {sheetMail && (
            <div className="sheet-body">
              <MailReader mailId={sheetMail.mailId} item={mailItem} heading="h2" idp="sheet" onHandled={ui.handled} onNotImportant={ui.notImportant} onRun={ui.run} busy={ui.busy} />
            </div>
          )}
        </Sheet>
      )}
    </Ctx.Provider>
  );
}

/** The groups, the skipped lines, Handled · N and Your rules. `limit`: Today's top N with See all. */
function ImportantList({ limit, go, idp = '' }: { limit?: number; go?: (v: View) => void; idp?: string }) {
  const items = useItems();
  const ui = useUi();
  const actions = useItemActions();
  const now = useNow();
  const { connection } = useMeta();
  const [showHandled, setShowHandled] = useState(false);
  if (!items.supported) return <p className="empty" style={{ textAlign: 'left' }}>{items.reason}</p>;
  if (!items.loaded) {
    const away = connection === 'offline' || connection === 'unreachable';
    return <p className="empty" role="status">{items.error ?? (away ? 'I can’t reach your helper right now. Your list will show when you’re back online.' : 'Loading your list…')}</p>;
  }
  const open = items.groups.flatMap((g) => g.items);
  const row = (it: ImportantItem) => (
    <ItemRow key={it.id} it={it} now={now} swiped={ui.swiped === it.id} busy={ui.busy(it)}
      onOpen={() => ui.open(it)} onAction={() => ui.run(it)} onSwipe={() => ui.swipe(it.id)} onUnswipe={() => ui.swipe(null)}
      onHandled={() => ui.handled(it)} onNotImportant={() => ui.notImportant(it)} />
  );
  if (limit) {
    const top = open.slice(0, limit);
    if (!top.length) return <p className="empty" style={{ textAlign: 'left' }}>You’re all caught up. I’ll add things here as they come in.</p>;
    return (
      <>
        <ul className="items panel">{top.map(row)}</ul>
        {open.length > limit && go && <p className="seeall"><button type="button" className="linkish quietlink" onClick={() => go('inbox')}>See all ({open.length})</button></p>}
      </>
    );
  }
  const sorting = items.sorting;
  return (
    <>
      {sorting?.note && <p className="sortnote" role="status">{sorting.note}</p>}
      {items.groups.map((g) => {
        const line = skipLine(g.group, items.skipped?.[g.group]);
        if (!g.items.length && !line) return null;
        return (
          <section key={g.group} aria-labelledby={`ig-${g.group}${idp}`}>
            <h2 className="sh" id={`ig-${g.group}${idp}`}>{g.label}</h2>
            {g.items.length ? <ul className="items panel">{g.items.map(row)}</ul> : <p className="empty" style={{ textAlign: 'left', padding: '6px 4px' }}>All clear.</p>}
            {line && (
              <p className="skipline">{line} · <button type="button" className="linkish quietlink" aria-haspopup="dialog" onClick={() => ui.showSkipped(g.group)}>Show them</button></p>
            )}
          </section>
        );
      })}
      {!open.length && <p className="empty"><span className="big" aria-hidden="true">✓</span>You’re all caught up. I’ll add things here as they come in.</p>}
      {items.handled.length > 0 && (
        <section className="handled" aria-labelledby={`hd-h${idp}`}>
          <h2 className="sr-only" id={`hd-h${idp}`}>Handled</h2>
          <button type="button" className="handledtoggle" aria-expanded={showHandled} onClick={() => setShowHandled((v) => !v)}>
            <CheckIcon />Handled · {items.handled.length}<Chev />
          </button>
          {showHandled && (
            <ul className="skiplist">
              {items.handled.map((it) => (
                <li key={it.id} className="skiprow"><span className="grow">{it.title}</span>
                  <button type="button" className="vbtn vbtn-quiet" onClick={() => { void actions.undo(it); }}>Undo</button></li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="ruleslink"><button type="button" className="linkish quietlink" aria-haspopup="dialog" onClick={ui.showRules}>Your rules</button></p>
    </>
  );
}

/** Today's "Worth a look": the same list (top `limit` on a phone). */
export function ImportantBody({ go, limit }: { go?: (v: View) => void; limit?: number }) {
  return <ImportantProvider go={go}><ImportantList go={go} limit={limit} idp="-today" /></ImportantProvider>;
}

/** The Important tab. */
export function Important({ desk, go }: ScreenProps) {
  const items = useItems();
  const now = useNow();
  const [all, setAll] = useState(false);
  const [reading, setReading] = useState<{ mailId: string; itemId: string | null; from: 'list' | 'all' } | null>(null);
  const openMail = useCallback((mailId: string, item: ImportantItem | null) => {
    setReading({ mailId, itemId: item?.id ?? null, from: all ? 'all' : 'list' });
    if (!desk) window.scrollTo(0, 0);
  }, [all, desk]);
  const onGone = useCallback((it: ImportantItem) => setReading((r) => (r?.itemId === it.id ? null : r)), []);
  const item = reading?.itemId ? items.byId[reading.itemId] ?? null : null;
  return (
    <ImportantProvider go={go} openMail={openMail} onGone={onGone}>
      <ImportantScreenBody desk={desk} now={now} all={all} setAll={setAll} reading={reading} setReading={setReading} item={item} go={go} />
    </ImportantProvider>
  );
}

function ImportantScreenBody({ desk, now, all, setAll, reading, setReading, item, go }: {
  desk: boolean; now: number; all: boolean; setAll: (v: boolean) => void; go: (v: View) => void;
  reading: { mailId: string; itemId: string | null; from: 'list' | 'all' } | null; setReading: (r: null | { mailId: string; itemId: string | null; from: 'list' | 'all' }) => void;
  item: ImportantItem | null;
}) {
  const ui = useUi();
  const reader = reading && (
    <MailReader key={reading.mailId} mailId={reading.mailId} item={item} idp="main"
      back={desk ? undefined : { label: reading.from === 'all' ? 'All email' : 'Worth a look', onClick: () => setReading(null) }}
      onHandled={ui.handled} onNotImportant={ui.notImportant} onRun={ui.run} busy={ui.busy} />
  );
  const list = all
    ? <AllEmail back={() => { setAll(false); setReading(null); }} open={(id) => setReading({ mailId: id, itemId: null, from: 'all' })} selected={reading?.mailId} now={now} />
    : (
      <>
        <header className="vh"><div className="vh-text"><p className="vh-kicker">From mail, calendar and files</p><h1>Worth a look</h1></div>
          <button type="button" className="vbtn vbtn-quiet allmail" onClick={() => { setAll(true); setReading(null); }}>All email</button></header>
        <ImportantList go={go} />
      </>
    );
  if (!desk) return reader ?? list;
  return (
    <div className="cols cols-2">
      <div className="listcol">{list}</div>
      <div className="pane">{reader ?? <p className="empty" style={{ marginTop: 80 }}><span className="big" aria-hidden="true">✦</span>Pick something to see it here. Emails open with my note and Ask about this under them.</p>}</div>
    </div>
  );
}
