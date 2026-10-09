"""Logo z fotky: kuny vystrihnuté z bieleho pozadia vo žltom srdci. Výstup: logo.png a ikony aplikácie."""
from collections import deque
from PIL import Image, ImageDraw, ImageFilter
import sys
sys.path.insert(0, "tools")
from logo_png import path_pts, HEART  # rovnaký tvar srdca ako v logo.svg

src = Image.open("tools/kuny-foto.png").convert("RGBA")
W, H = src.size; px = src.load()
# 1) pozadie: biele pixely spojené s okrajom → priehľadné (biele náprsenky vo vnútri zostanú)
white = lambda p: min(p[:3]) > 196 and max(p[:3]) - min(p[:3]) < 22
seen = bytearray(W * H); q = deque()
for x in range(W): q += [(x, 0), (x, H - 1)]
for y in range(H): q += [(0, y), (W - 1, y)]
mask = Image.new("L", (W, H), 255); m = mask.load()
while q:
    x, y = q.popleft()
    if not (0 <= x < W and 0 <= y < H) or seen[y * W + x]: continue
    seen[y * W + x] = 1
    if not white(px[x, y]): continue
    m[x, y] = 0
    q += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
# biele miesta medzi labkami (dole, mimo náprseniek) tiež preč
for y in range(int(H * 0.78), H):
    for x in range(W):
        if white(px[x, y]): m[x, y] = 0
mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))  # bez bieleho lemu
cut = src.copy(); cut.putalpha(mask)
cut = cut.crop(cut.getbbox())

def render(size, bg=None, pad=0.0, S=4):
    N = size * S; k = N * (1 - 2 * pad) / 512; o = N * pad
    im = Image.new("RGBA", (N, N), bg or (0, 0, 0, 0))
    heart = Image.new("L", (N, N), 0)
    ImageDraw.Draw(heart).polygon([(o + x * k, o + y * k) for x, y in path_pts(HEART)], fill=255)
    layer = Image.new("RGBA", (N, N), "#f2b705")
    # kuny: šírka ~76 % srdca, spodok tesne nad hrotom srdca
    tw = int(352 * k); th = int(cut.height * tw / cut.width)
    kuny = cut.resize((tw, th), Image.LANCZOS)
    layer.alpha_composite(kuny, (int(o + 256 * k - tw / 2), int(o + 404 * k - th)))
    im.paste(layer, (0, 0), heart)
    return im.resize((size, size), Image.LANCZOS)

if __name__ == "__main__":
    BRAND = "#2b2860"
    for s in (180, 192, 512):
        render(s, BRAND, pad=0.08).convert("RGB").save(f"ikona-{s}.png", optimize=True)
    render(512).save("logo.png", optimize=True)
    render(64).save("favicon.png", optimize=True)
