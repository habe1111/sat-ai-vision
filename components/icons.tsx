/** 画面で使う線画アイコン。文字の太さに合わせて 1.75 の線で描く */
type P = { className?: string };
const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const IconSearch = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
);
export const IconClose = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
/** 範囲選択：四隅のトンボ */
export const IconFrame = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </svg>
);
export const IconPin = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></svg>
);
export const IconCheck = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);
export const IconAlert = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.5M12 17.2v.1" /></svg>
);
