'use client';
/**
 * 船・車の注釈ページ（開発用。next dev の手元でだけ開ける）。
 *
 * 流れ：自動の候補（黄色の破線）を見て、違うものを消し、足りないものを足し、
 * 「確認済みにして次へ」（Enter）を押す。残した候補はそのとき確定（水色の実線）になる。
 * 船と車は別々に確かめる（いまの種類だけを触れる。もう一方は薄く出る）。
 *
 * 開いているチップは URL の # に入れる（読み込み直しても同じチップに戻る）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Chip, type ChipSummary, OBJECT_LABEL, type ObjectKind, type Site,
  chipBBox, siteChips, chipId, summarize,
} from '@/lib/annotate';
import { type SaveState, useChipEditor } from '@/lib/client/useChipEditor';
import { ChipCanvas } from '@/components/annotate/ChipCanvas';

const ZOOMS = [1, 1.5, 2, 3, 4];

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  pending: '保存待ち…',
  saving: '保存中…',
  saved: '保存しました',
  error: '保存できませんでした',
  invalid: '保存できない注釈があります',
  conflict: 'ほかの所で書き換わりました',
};

type Row = ChipSummary & { siteName: string; index: number };

export default function Annotator() {
  const [sites, setSites] = useState<Site[]>([]);
  const [summaries, setSummaries] = useState<Map<string, ChipSummary>>(new Map());
  const [listError, setListError] = useState<string | null>(null);
  const [broken, setBroken] = useState<string[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [mode, setMode] = useState<ObjectKind>('ship');
  const [zoom, setZoom] = useState(1.5);
  const [showLandCover, setShowLandCover] = useState(false);
  const [hideMarks, setHideMarks] = useState(false);
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const onSaved = useCallback((c: Chip) => {
    setSummaries((m) => new Map(m).set(c.id, summarize(c)));
  }, []);
  const editor = useChipEditor(id, onSaved);
  const { chip } = editor;

  // 一覧（地点の順、地点の中は左上から）
  useEffect(() => {
    fetch('/api/dev/annotate', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`一覧を読み込めませんでした（${res.status}）。`);
        const body = (await res.json()) as { sites: Site[]; chips: ChipSummary[]; broken: string[] };
        setSites(body.sites);
        setBroken(body.broken);
        setSummaries(new Map(body.chips.map((c) => [c.id, c])));
      })
      .catch((e) => setListError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const placed = new Set<string>();
    for (const s of sites) {
      siteChips(s).forEach(({ x, y }, i) => {
        const c = summaries.get(chipId(x, y));
        if (c && !placed.has(c.id)) {
          placed.add(c.id);
          out.push({ ...c, siteName: s.name, index: i + 1 });
        }
      });
    }
    // 地点の一覧から外れたチップも、注釈を失わないよう最後に出す
    for (const c of summaries.values()) if (!placed.has(c.id)) out.push({ ...c, siteName: c.site, index: 0 });
    return out;
  }, [sites, summaries]);

  // 最初に開くチップ：URL の #、無ければいまの種類で最初の未確認
  useEffect(() => {
    if (id || rows.length === 0) return;
    const fromHash = decodeURIComponent(window.location.hash.slice(1));
    const pick = rows.find((r) => r.id === fromHash) ?? rows.find((r) => !r.reviewed[mode]) ?? rows[0];
    // 一覧が届いた後に 1 回だけ選ぶ
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setId(pick.id);
  }, [rows, id, mode]);

  useEffect(() => {
    if (id) window.history.replaceState(null, '', `#${id}`);
  }, [id]);

  // 移っている途中（保存を待っている・次のチップを読み込んでいる）は、次の移動や「確認済み」を受け付けない
  const moving = useRef(false);
  const go = useCallback(async (next: string | undefined) => {
    if (!next || next === id || moving.current) return;
    moving.current = true;
    try {
      // 保存し終えてから移る。保存できないときは、編集を捨ててよいか確かめる
      const ok = await editor.flush();
      if (!ok && !window.confirm('このチップの編集を保存できていません。捨ててほかのチップへ移りますか？')) return;
      setSelected(new Set());
      setId(next);
    } finally {
      moving.current = false;
    }
  }, [editor, id]);

  const visible = onlyTodo ? rows.filter((r) => !r.reviewed[mode] || r.id === id) : rows;
  const at = visible.findIndex((r) => r.id === id);
  const nextTodo = () => {
    const after = rows.slice(rows.findIndex((r) => r.id === id) + 1).concat(rows);
    return after.find((r) => r.id !== id && !r.reviewed[mode])?.id;
  };

  const newId = useCallback(() => `h-${Date.now().toString(36)}-${(seq.current++).toString(36)}`, []);

  const select = useCallback((ids: string[], additive: boolean) => {
    setSelected((prev) => {
      if (!additive) return new Set(ids);
      const next = new Set(prev);
      // Shift で押したものは、選んでいれば外し、選んでいなければ足す（囲みは足すだけ）
      if (ids.length === 1 && prev.has(ids[0])) next.delete(ids[0]);
      else ids.forEach((i) => next.add(i));
      return next;
    });
  }, []);

  const removeSelected = useCallback(() => {
    if (!selected.size) return;
    editor.edit((objs) => objs.filter((o) => !selected.has(o.id)));
    setSelected(new Set());
  }, [editor, selected]);

  const acceptSelected = useCallback(() => {
    if (!selected.size) return;
    editor.edit((objs) => objs.map((o) => (selected.has(o.id) ? { ...o, status: 'accepted' as const } : o)));
  }, [editor, selected]);

  const toggleDifficult = useCallback(() => {
    if (!selected.size || !chip) return;
    const on = !chip.objects.filter((o) => selected.has(o.id)).every((o) => o.difficult);
    // 外すときは undefined にする（JSON に書くときに消える）
    editor.edit((objs) => objs.map((o) => (selected.has(o.id) ? { ...o, status: 'accepted' as const, difficult: on || undefined } : o)));
  }, [chip, editor, selected]);

  const reviewAndNext = useCallback(() => {
    // 読み込み中は、まだ見ていない次のチップを確認済みにしてしまうので受け付けない
    if (!chip || editor.loading || moving.current) return;
    editor.setReviewed(mode, true);
    setSelected(new Set());
    void go(nextTodo());
    // nextTodo は rows と id から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chip, editor, mode, go, rows, id]);

  const changeMode = useCallback((m: ObjectKind) => {
    setMode(m);
    setSelected(new Set());
  }, []);

  /*
   * キー操作。文字のキーは e.code で見る（Caps Lock・Shift で e.key が変わっても同じに効かせる）。
   * 文字を打つ欄にフォーカスがあるときと、日本語入力の変換中は何もしない。
   * Enter はボタンにフォーカスが残っていても「確認済みにして次へ」にする（押したボタンをもう一度押さない）
   */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.isComposing || e.key === 'Process') return;
      if (t.closest('textarea, input:not([type="checkbox"])')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        // やり直し（⌘⇧Z）は無いので、何もしない（もう 1 つ戻してしまわないため）
        if (!e.shiftKey) editor.undo();
        return;
      }
      if (mod || e.altKey) return;
      // 押し続けたときのキーリピートで、見ていないチップを確認済みにしたり飛ばしたりしない
      if (e.repeat && (e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); return; }
      // 拡大の select では、← → で値が変わらないようにする
      if (t.closest('select') && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Enter') return;
      switch (e.code === 'KeyA' && e.shiftKey ? 'ShiftA' : e.code) {
        case 'Digit1': case 'KeyS': changeMode('ship'); break;
        case 'Digit2': case 'KeyC': changeMode('car'); break;
        case 'Delete': case 'Backspace': e.preventDefault(); removeSelected(); break;
        case 'KeyA': acceptSelected(); break;
        case 'ShiftA':
          if (chip) setSelected(new Set(chip.objects.filter((o) => o.kind === mode).map((o) => o.id)));
          break;
        case 'KeyD': toggleDifficult(); break;
        case 'Enter': case 'NumpadEnter': e.preventDefault(); reviewAndNext(); break;
        case 'ArrowRight': case 'BracketRight': e.preventDefault(); void go(visible[at + 1]?.id); break;
        case 'ArrowLeft': case 'BracketLeft': e.preventDefault(); void go(visible[at - 1]?.id); break;
        case 'KeyL': setShowLandCover((v) => !v); break;
        case 'KeyH': setHideMarks(true); break;
        case 'Escape': setSelected(new Set()); break;
        case 'Equal': case 'NumpadAdd': setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]); break;
        case 'Minus': case 'NumpadSubtract': setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]); break;
        default: return;
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'KeyH') setHideMarks(false); };
    // 押している間だけ注釈を隠すので、ほかの窓へ移ったら戻す
    const blur = () => setHideMarks(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [editor, changeMode, removeSelected, acceptSelected, toggleDifficult, reviewAndNext, go, visible, at, chip, mode]);

  const site = chip ? sites.find((s) => s.id === chip.site) : undefined;
  const counts = chip ? summarize(chip).counts[mode] : null;
  const center = chip ? chipBBox(chip.x, chip.y) : null;
  const doneCount = rows.filter((r) => r.reviewed[mode]).length;

  return (
    <div className="grid h-dvh grid-cols-[17rem_1fr_19rem] bg-paper text-sm text-ink">
      {/* 一覧 */}
      <nav aria-label="チップの一覧" className="flex min-h-0 flex-col border-r border-rule">
        <div className="border-b border-rule p-3">
          <h1 className="text-base font-bold">注釈（開発用）</h1>
          <p className="num mt-1 text-xs text-ink-2">{OBJECT_LABEL[mode]}：{doneCount} / {rows.length} 枚 確認済み</p>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} />
            未確認だけを出す
          </label>
        </div>
        {listError && <p role="alert" className="p-3 text-danger">{listError}</p>}
        {broken.length > 0 && (
          <p role="alert" className="p-3 text-xs leading-relaxed text-danger">
            読めないチップのファイルがあります（{broken.join('、')}）。上書きしないよう一覧から外しています。手で直してください。
          </p>
        )}
        {!listError && rows.length === 0 && (
          <p className="p-3 text-xs leading-relaxed text-ink-2">チップがありません。npm run annotate:prepare で作ってください。</p>
        )}
        <ol className="min-h-0 flex-1 overflow-y-auto py-1">
          {visible.map((r, i) => {
            const c = r.counts[mode];
            const head = i === 0 || visible[i - 1].siteName !== r.siteName;
            return (
              <li key={r.id}>
                {head && <p className="px-3 pt-3 pb-1 text-xs font-bold text-ink-2">{r.siteName}</p>}
                <button
                  type="button"
                  onClick={() => void go(r.id)}
                  data-chip={r.id}
                  aria-current={r.id === id ? 'true' : undefined}
                  className={`num flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-paper-2 ${r.id === id ? 'bg-paper-2 font-bold' : ''}`}
                >
                  <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${r.reviewed[mode] ? 'bg-[#1b8fa6]' : 'border border-ink-2'}`} />
                  <span className="flex-1">#{r.index || '–'}</span>
                  <span className="text-ink-2">
                    {r.reviewed[mode] ? `${c.accepted} 件` : `候補 ${c.proposed}・確定 ${c.accepted}`}
                  </span>
                  <span className="sr-only">{r.reviewed[mode] ? '確認済み' : '未確認'}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* 写真 */}
      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
          <div role="group" aria-label="注釈する種類" className="flex overflow-hidden rounded-md border border-rule">
            {(['ship', 'car'] as const).map((k, i) => (
              <button
                key={k}
                type="button"
                aria-pressed={mode === k}
                onClick={() => changeMode(k)}
                className={`px-3 py-1.5 ${mode === k ? 'bg-ink text-white' : 'bg-white hover:bg-paper-2'}`}
              >
                {OBJECT_LABEL[k]}<kbd className="ml-1.5 text-[10px] opacity-70">{i + 1}</kbd>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5">
            拡大
            <select value={zoom} onChange={(e) => { setZoom(Number(e.target.value)); e.target.blur(); }} className="rounded border border-rule bg-white px-1.5 py-1">
              {ZOOMS.map((z) => <option key={z} value={z}>{z}×</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showLandCover} onChange={(e) => setShowLandCover(e.target.checked)} />
            土地被覆<kbd className="text-[10px] text-ink-2">L</kbd>
          </label>
          <span className="flex-1" />
          <button type="button" onClick={() => void go(visible[at - 1]?.id)} disabled={at <= 0} className="rounded border border-rule bg-white px-2.5 py-1 disabled:opacity-40">← 前</button>
          <button type="button" onClick={() => void go(visible[at + 1]?.id)} disabled={at < 0 || at >= visible.length - 1} className="rounded border border-rule bg-white px-2.5 py-1 disabled:opacity-40">次 →</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-[#0d1418] p-4">
          {editor.loadError && <p role="alert" className="text-white">{editor.loadError}</p>}
          {chip && (
            <div aria-busy={editor.loading} className={editor.loading ? 'pointer-events-none opacity-40' : undefined}>
            <ChipCanvas
              chip={chip}
              mode={mode}
              zoom={zoom}
              showLandCover={showLandCover}
              hideMarks={hideMarks}
              selected={selected}
              onSelect={select}
              onEdit={editor.edit}
              onCheckpoint={editor.checkpoint}
              newId={newId}
            />
            </div>
          )}
        </div>
      </main>

      {/* 操作 */}
      <aside aria-label="注釈の操作" className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-rule p-3">
        {chip && (
          <section>
            <h2 className="font-bold">{site?.name ?? chip.site}</h2>
            <p className="num mt-0.5 text-xs text-ink-2">
              {chip.id}・約 {chip.mpp} m/px
              {center && (
                <>
                  {'・'}
                  <a
                    href={`https://maps.gsi.go.jp/#18/${((center[1] + center[3]) / 2).toFixed(6)}/${((center[0] + center[2]) / 2).toFixed(6)}/`}
                    target="_blank"
                    rel="noopener"
                    className="underline"
                  >
                    地理院地図
                  </a>
                </>
              )}
            </p>
            <p className="num mt-2">
              {OBJECT_LABEL[mode]}：候補 {counts?.proposed ?? 0}・確定 {counts?.accepted ?? 0}
              {chip.reviewed[mode] && <span className="ml-2 rounded bg-[#1b8fa6] px-1.5 py-0.5 text-xs text-white">確認済み</span>}
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              <button type="button" onClick={reviewAndNext} className="rounded-md bg-ink px-3 py-2 font-bold text-white hover:bg-ink/90">
                確認済みにして次へ <kbd className="ml-1 text-[10px] opacity-70">Enter</kbd>
              </button>
              {chip.reviewed[mode] && (
                <button type="button" onClick={() => editor.setReviewed(mode, false)} className="rounded-md border border-rule bg-white px-3 py-1.5">
                  確認済みを外す
                </button>
              )}
            </div>
            <p aria-live="polite" className={`mt-2 text-xs ${editor.save === 'error' || editor.save === 'conflict' ? 'text-danger' : 'text-ink-2'}`}>
              {SAVE_LABEL[editor.save]}
            </p>
            {editor.save === 'invalid' && editor.saveError && (
              <p className="mt-1 text-xs leading-relaxed text-danger">{editor.saveError}元に戻すか、その注釈を消してください。</p>
            )}
            {editor.save === 'error' && (
              <button type="button" onClick={() => void editor.retry()} className="mt-1 rounded border border-rule bg-white px-2 py-1 text-xs">保存し直す</button>
            )}
            {editor.save === 'conflict' && (
              <button type="button" onClick={editor.reload} className="mt-1 rounded border border-rule bg-white px-2 py-1 text-xs">読み込み直す（この画面の編集は捨てる）</button>
            )}
          </section>
        )}

        <section aria-label="選んでいる注釈">
          <h2 className="font-bold">選択中：<span className="num">{selected.size}</span> 件</h2>
          <div className="mt-2 grid grid-cols-3 gap-1.5 text-xs">
            <button type="button" disabled={!selected.size} onClick={acceptSelected} className="rounded border border-rule bg-white px-1.5 py-1.5 disabled:opacity-40">確定 <kbd>A</kbd></button>
            <button type="button" disabled={!selected.size} onClick={toggleDifficult} className="rounded border border-rule bg-white px-1.5 py-1.5 disabled:opacity-40">見えにくい <kbd>D</kbd></button>
            <button type="button" disabled={!selected.size} onClick={removeSelected} className="rounded border border-rule bg-white px-1.5 py-1.5 text-danger disabled:opacity-40">削除 <kbd>Del</kbd></button>
          </div>
          <button type="button" disabled={!editor.canUndo} onClick={editor.undo} className="mt-1.5 w-full rounded border border-rule bg-white px-2 py-1.5 text-xs disabled:opacity-40">
            元に戻す <kbd>⌘Z</kbd>
          </button>
        </section>

        <section aria-label="凡例">
          <h2 className="font-bold">凡例</h2>
          <ul className="mt-1.5 space-y-1 text-xs">
            <li><Swatch color="#ffd400" dashed />候補（自動・Claude。まだ確かめていない）</li>
            <li><Swatch color="#3ee0ff" />確定（人が確かめた）</li>
            <li><Swatch color="#ff8a00" dashed />見えにくい（学習で数えない）</li>
            <li><Swatch color="#ff3fb0" />選択中</li>
          </ul>
        </section>

        <section aria-label="操作のしかた">
          <h2 className="font-bold">操作</h2>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            {(mode === 'car'
              ? [['クリック', '車の中心に点を打つ'], ['ドラッグ', '囲んで選ぶ／点を動かす']]
              : [['ドラッグ', '船首から船尾へ線を引いて枠を作る'], ['取っ手', '端：長さと向き。側面：幅']]
            ).concat([
              ['Shift+ドラッグ', '囲んで選ぶ（足していく）'],
              ['Shift+クリック', '選ぶ・外す'],
              ['Shift+A', 'すべて選ぶ'],
              ['A・D・Del', '確定・見えにくい・削除'],
              ['Enter', '確認済みにして次へ'],
              ['Esc', '選ぶのをやめる'],
              ['H（押す間）', '注釈を隠して写真を見る'],
              ['← →', '前・次のチップ'],
              ['+ −', '拡大・縮小'],
            ]).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-bold whitespace-nowrap">{k}</dt>
                <dd className="text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">キー操作は日本語入力をオフにして使います。</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">
            {mode === 'car'
              ? '車は中心に 1 点。トラック・バスも含めます。屋根の下などで見えない車は付けません。'
              : '船は船体の外形に合わせた枠。桟橋につないだ船も 1 隻ずつ。浮き桟橋・ブイは付けません。'}
          </p>
        </section>

        <p className="mt-auto text-[11px] leading-relaxed text-ink-2">
          写真：国土地理院「全国最新写真（シームレス）」。注釈は data/annotations/ に保存（CC BY 4.0 で公開予定）。
        </p>
      </aside>
    </div>
  );
}

function Swatch({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className="mr-1.5 inline-block size-3 rounded-full align-[-2px]"
      style={{ border: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, background: '#14212b' }}
    />
  );
}
