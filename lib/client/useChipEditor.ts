'use client';
/**
 * 注釈ページで、1 枚のチップを読み込み・編集し・保存する。
 *
 * 編集はすぐ画面に出し、保存は少し待ってまとめて送る（点を続けて打っても、1 回ごとには書かない）。
 * 保存は 1 本ずつ順に送り、サーバーの updatedAt を付けて、ほかの所（Claude の下付けなど）が
 * 書き換えていたら上書きせずに止める。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, Chip, ObjectKind } from '@/lib/annotate';

/** invalid … サーバーが注釈の形を断った（送り直しても通らないので、直すか元に戻す） */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'invalid' | 'conflict';

/** 編集してから保存するまでの待ち時間（ms） */
const SAVE_DELAY = 600;
/** 元に戻せる回数 */
const HISTORY = 100;

/** 元に戻す点。確認済みの印も一緒に戻す（候補だけ戻ると「確認済みなのに候補が残る」状態になる） */
type Snapshot = Pick<Chip, 'objects' | 'reviewed'>;

export function useChipEditor(id: string | null, onSaved: (chip: Chip) => void) {
  const [chip, setChip] = useState<Chip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [canUndo, setCanUndo] = useState(false);
  const latest = useRef<Chip | null>(null);
  /** サーバーにある版（保存のたびに進む） */
  const base = useRef<string | null>(null);
  const dirty = useRef(false);
  const conflict = useRef(false);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const history = useRef<Snapshot[]>([]);
  /** 開こうとしているチップ。読み込み終わるまでは、前のチップへの編集を受け付けない */
  const wanted = useRef(id);
  useEffect(() => { wanted.current = id; }, [id]);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; });

  const send = useCallback(async (): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // 前の保存が終わってから送る（順番が入れ替わると、古い内容で上書きしてしまう）
    while (inflight.current) await inflight.current;
    const c = latest.current;
    if (!dirty.current || !c || conflict.current) return;
    dirty.current = false;
    setSave('saving');
    const run = (async () => {
      try {
        const res = await fetch(`/api/dev/annotate/${c.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ objects: c.objects, reviewed: c.reviewed, updatedAt: base.current }),
        });
        if (res.status === 409) {
          conflict.current = true;
          dirty.current = true;
          setSave('conflict');
          return;
        }
        if (res.status === 400) {
          // 形の正しくない注釈がある。送り直しても同じなので、直されるまで待つ（次の編集でまた送る）
          dirty.current = true;
          setSaveError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? '注釈の形が正しくありません。');
          setSave('invalid');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const saved = (await res.json()) as Chip;
        // 保存している間に別のチップへ移っていたら、そちらの版を書き換えない
        if (latest.current?.id === saved.id) base.current = saved.updatedAt;
        onSavedRef.current(saved);
        setSaveError(null);
        setSave(dirty.current ? 'pending' : 'saved');
      } catch {
        dirty.current = true;
        setSave('error');
      }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
  }, []);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSave('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), SAVE_DELAY);
  }, [send]);

  /** 読み込んだチップを、編集の起点にする */
  const accept = useCallback((c: Chip) => {
    // 前のチップの保存待ちは、移る前に flush で送り終えている（送れなかったものは、移るときに捨ててよいと確かめた）
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    latest.current = c;
    base.current = c.updatedAt;
    dirty.current = false;
    conflict.current = false;
    history.current = [];
    setCanUndo(false);
    setChip(c);
    setLoadError(null);
    setSaveError(null);
    setSave('idle');
  }, []);

  const load = useCallback((target: string, signal?: AbortSignal) => {
    fetchChip(target, signal)
      .then(accept)
      .catch((e) => {
        if (!signal?.aborted) setLoadError(e instanceof Error ? e.message : String(e));
      });
  }, [accept]);

  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    load(id, ac.signal);
    return () => ac.abort();
  }, [id, load]);

  // 保存していない編集があるまま閉じようとしたら止める
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current || inflight.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const apply = useCallback((next: Chip) => {
    latest.current = next;
    setChip(next);
    schedule();
  }, [schedule]);

  /** 画面に出ているチップを、いま編集してよいか（別のチップを読み込み中・書き換わったときは不可） */
  const editable = (c: Chip | null): c is Chip => c !== null && c.id === wanted.current && !conflict.current;

  /** 元に戻す点を 1 つ積む（ドラッグの始めに 1 回だけ呼び、動かしている間は積まない） */
  const checkpoint = useCallback(() => {
    const c = latest.current;
    if (!editable(c)) return;
    history.current.push({ objects: c.objects, reviewed: c.reviewed });
    if (history.current.length > HISTORY) history.current.shift();
    setCanUndo(true);
  }, []);

  /** 注釈を書き換える。record なら元に戻す点も積む */
  const edit = useCallback((fn: (objects: Annotation[]) => Annotation[], record = true) => {
    const c = latest.current;
    if (!editable(c)) return;
    if (record) checkpoint();
    apply({ ...c, objects: fn(c.objects) });
  }, [apply, checkpoint]);

  /**
   * 種類ごとの「確認済み」を切り替える。確認済みにするときは、残っている候補も人が確かめたものとして確定する
   * （消さずに残した候補は、見て正しいと判断したもの）
   */
  const setReviewed = useCallback((kind: ObjectKind, value: boolean) => {
    const c = latest.current;
    if (!editable(c)) return;
    checkpoint();
    const objects = value
      ? c.objects.map((o) => (o.kind === kind && o.status === 'proposed' ? { ...o, status: 'accepted' as const } : o))
      : c.objects;
    apply({ ...c, objects, reviewed: { ...c.reviewed, [kind]: value } });
  }, [apply, checkpoint]);

  const undo = useCallback(() => {
    const c = latest.current;
    if (!editable(c)) return;
    const prev = history.current.pop();
    setCanUndo(history.current.length > 0);
    if (!prev) return;
    apply({ ...c, ...prev });
  }, [apply]);

  /** 保存を待たずに送り、終わるまで待つ（ほかのチップへ移る前に呼ぶ）。保存できていれば true */
  const flush = useCallback(async (): Promise<boolean> => {
    if (dirty.current && !conflict.current) await send();
    while (inflight.current) await inflight.current;
    return !dirty.current;
  }, [send]);

  /** サーバーの内容を読み直す（書き換わっていたとき。こちらの保存していない編集は捨てる） */
  const reload = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const c = latest.current;
    if (c) load(c.id);
  }, [load]);

  /** 画面のチップが、開こうとしているものと違う（読み込み中） */
  const loading = chip !== null && chip.id !== id;
  return { chip, loading, loadError, save, saveError, canUndo, edit, checkpoint, setReviewed, undo, flush, reload, retry: send };
}

async function fetchChip(id: string, signal?: AbortSignal): Promise<Chip> {
  const res = await fetch(`/api/dev/annotate/${id}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'チップが見つかりません。' : `読み込めませんでした（${res.status}）。`);
  return (await res.json()) as Chip;
}
