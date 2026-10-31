"""国土基本図の図郭（地図情報レベル 500：400 m × 300 m）と、平面直角座標・経緯度の行き来"""
from pyproj import Transformer

ROWS = 'ABCDEFGHIJKLMNOPQRST'   # 北から 30 km ごと
COLS = 'ABCDEFGH'               # 西から 40 km ごと

def to_plane(zone, lon, lat):
    t = Transformer.from_crs('EPSG:6668', f'EPSG:{6668 + zone}', always_xy=True)  # JGD2011 → 平面直角 第 zone 系
    y, x = t.transform(lon, lat)   # 東向きが Y、北向きが X
    return x, y

def mesh_of(zone, lon, lat):
    x, y = to_plane(zone, lon, lat)
    r, c = int((300000 - x) // 30000), int((y + 160000) // 40000)
    x0, y0 = 300000 - r * 30000, -160000 + c * 40000
    r5, c5 = int((x0 - x) // 3000), int((y - y0) // 4000)
    x1, y1 = x0 - r5 * 3000, y0 + c5 * 4000
    r6, c6 = int((x1 - x) // 300), int((y - y1) // 400)
    return f'{zone:02d}{ROWS[r]}{COLS[c]}{r5}{c5}{r6}{c6}'

def mesh_origin(code):
    """図郭の左上（北西）の平面座標 (x, y)"""
    r, c = ROWS.index(code[2]), COLS.index(code[3])
    x = 300000 - r * 30000 - int(code[4]) * 3000 - int(code[6]) * 300
    y = -160000 + c * 40000 + int(code[5]) * 4000 + int(code[7]) * 400
    return x, y

if __name__ == '__main__':
    for code in ('08ND7688', '08NF3228'):
        print(code, '左上（X 北, Y 東）=', mesh_origin(code))


def mesh_at_plane(zone, x, y):
    """平面座標 (x 北, y 東) を含む図郭"""
    r, c = int((300000 - x) // 30000), int((y + 160000) // 40000)
    x0, y0 = 300000 - r * 30000, -160000 + c * 40000
    r5, c5 = int((x0 - x) // 3000), int((y - y0) // 4000)
    x1, y1 = x0 - r5 * 3000, y0 + c5 * 4000
    r6, c6 = int((x1 - x) // 300), int((y - y1) // 400)
    return f'{zone:02d}{ROWS[r]}{COLS[c]}{r5}{c5}{r6}{c6}'


def neighbors(code):
    """図郭とそのまわり 8 区画（北西から順に 3×3）"""
    zone = int(code[:2])
    x, y = mesh_origin(code)
    return [mesh_at_plane(zone, x - 150 - dr * 300, y + 200 + dc * 400) for dr in (-1, 0, 1) for dc in (-1, 0, 1)]
