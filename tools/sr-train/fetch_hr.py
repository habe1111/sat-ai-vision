"""
places.json の各地点のまわり 3×3 区画（1 区画 400 m × 300 m）の 0.2 m の写真を取り、.tif と .tfw だけを取り出す。

    .venv/bin/python fetch_hr.py ../../.cache/hr

公開元に負荷をかけないよう 1 区画ずつ順に取り、取ったものは取り直さない。
- 東京都デジタルツイン実現プロジェクト（多摩地域、航空レーザ用数値写真データ（オルソ画像）、CC BY 4.0）
- 静岡県 VIRTUAL SHIZUOKA（オルソ画像、CC BY 4.0）
"""
import io, json, os, sys, time, urllib.request, zipfile
from mesh import neighbors

OUT = sys.argv[1]
UA = {'User-Agent': 'sat_ai_vision/0.1 (local research app; https://github.com/habe1111/sat-ai-vision)'}
places = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'places.json'), encoding='utf-8'))
index = []
for p in places:
    for code in neighbors(p['mesh']):
        url = p['url'].replace(p['mesh'], code) if p['zone'] == 9 else p['url'].split('/LP/')[0] + f'/LP/Ortho/08/{code[2:4]}/{code[4:6]}/{code}.zip'
        dest = os.path.join(OUT, f'{code}.tif')
        index.append({'mesh': code, 'place': p['name'], 'kind': p['kind'], 'zone': p['zone'], 'source': url})
        if os.path.exists(dest):
            continue
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except Exception as e:
            print('なし', code, p['name'], e); index[-1]['missing'] = True; continue
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for n in z.namelist():
                ext = os.path.splitext(n)[1].lower()
                if ext in ('.tif', '.tfw') and '..' not in n:
                    with open(os.path.join(OUT, f'{code}{ext}'), 'wb') as f:
                        f.write(z.read(n))
        print('取得', code, p['name'], round(len(data) / 1e6, 1), 'MB', flush=True)
        time.sleep(0.5)
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), ensure_ascii=False, indent=1)
print('終わり', len(index), '区画')
