"""v2 test visual analysis: rotation continuity, 3rd-person preservation, tap no-op."""
from PIL import Image

BASE = '/home/z/my-project/tool-results'

def load(p):
    im = Image.open(p).convert('RGB').resize((284, 160))
    return list(im.getdata())

def diff(a, b, region=None):
    da, db = load(a), load(b)
    n = len(da)
    if region == 'top':
        idx = list(range(0, n // 2))
    elif region == 'bottom':
        idx = list(range(n // 2, n))
    else:
        idx = list(range(n))
    return sum(abs(da[i][0]-db[i][0]) + abs(da[i][1]-db[i][1]) + abs(da[i][2]-db[i][2]) for i in idx) / (len(idx) * 3)

def teal_count(path):
    """Tommy visibility: teal shirt cluster in bottom-center band."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    count = 0
    for y in range(int(h*0.45), h):
        for x in range(int(w*0.28), int(w*0.72)):
            r, g, b = px[x, y]
            if b > r + 12 and g > r + 2 and b < 160 and abs(g - b) < 60:
                count += 1
    return count

pairs = [
    ('t1 rotation vs baseline', f'{BASE}/v2-1-baseline.png', f'{BASE}/v2-t1-right-after.png'),
    ('t1 hold vs after (recenter settle)', f'{BASE}/v2-t1-right-hold.png', f'{BASE}/v2-t1-right-after.png'),
    ('t2 pitch vs baseline', f'{BASE}/v2-1-baseline.png', f'{BASE}/v2-t2-up-after.png'),
    ('t3 progressive m10->m20', f'{BASE}/v2-t3-slide-m10.png', f'{BASE}/v2-t3-slide-m20.png'),
    ('t3 progressive m20->end', f'{BASE}/v2-t3-slide-m20.png', f'{BASE}/v2-t3-slide-end.png'),
    ('t4 tap hold vs after (EXPECT ~0)', f'{BASE}/v2-t4-tap-hold.png', f'{BASE}/v2-t4-tap-after.png'),
    ('t5 multitouch vs baseline', f'{BASE}/v2-1-baseline.png', f'{BASE}/v2-t5-multi-mid.png'),
]

print('=== pixel diff (0-255 scale; >2 = visible scene change) ===')
for name, a, b in pairs:
    try:
        print(f'{name:42s} whole={diff(a, b):6.2f}  top={diff(a, b, "top"):6.2f}  bottom={diff(a, b, "bottom"):6.2f}')
    except Exception as e:
        print(f'{name}: ERR {e}')

print()
print('=== Tommy visibility (teal shirt bottom-center; first-person switch collapses it) ===')
for name, p in [
    ('baseline', f'{BASE}/v2-1-baseline.png'),
    ('t1 after', f'{BASE}/v2-t1-right-after.png'),
    ('t2 after', f'{BASE}/v2-t2-up-after.png'),
    ('t3 end', f'{BASE}/v2-t3-slide-end.png'),
    ('final', f'{BASE}/v2-9-final.png'),
]:
    try:
        print(f'{name:12s} teal={teal_count(p)}')
    except Exception as e:
        print(f'{name}: ERR {e}')
