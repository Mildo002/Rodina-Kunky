"""Vykreslí logo (srdce s dvoma kunami) do PNG bez SVG knižnice – rovnaké tvary ako logo.svg."""
import re, sys
from PIL import Image, ImageDraw

S = 4  # prevzorkovanie kvôli hladkým hranám
def bez(p0, p1, p2, p3, n=40):
    return [tuple((1-t)**3*a + 3*(1-t)**2*t*b + 3*(1-t)*t**2*c + t**3*d for a, b, c, d in zip(p0, p1, p2, p3))
            for t in (i / n for i in range(n + 1))]
def path_pts(d):
    tok = re.findall(r"[MCZ]|-?\d+\.?\d*", d); i = 0; pts = []; cur = None; cmd = None
    while i < len(tok):
        if tok[i] in "MCZ": cmd = tok[i]; i += 1
        if cmd == "M": cur = (float(tok[i]), float(tok[i+1])); pts.append(cur); i += 2; cmd = "C"
        elif cmd == "C":
            p1 = (float(tok[i]), float(tok[i+1])); p2 = (float(tok[i+2]), float(tok[i+3])); p3 = (float(tok[i+4]), float(tok[i+5]))
            pts += bez(cur, p1, p2, p3)[1:]; cur = p3; i += 6
        elif cmd == "Z": break
    return pts

EAR1 = "M180 164 C 176 146, 184 134, 196 136 C 205 138, 208 150, 204 160 Z"
EAR2 = "M204 152 C 203 134, 213 124, 225 128 C 234 132, 233 146, 226 154 Z"
HEART = "M256 462 C 118 372, 40 288, 40 182 C 40 108, 98 54, 166 54 C 206 54, 238 74, 256 104 C 274 74, 306 54, 346 54 C 414 54, 472 108, 472 182 C 472 288, 394 372, 256 462 Z"
TAIL = "M150 404 C 94 404, 64 350, 80 290 C 86 268, 120 266, 124 290 C 120 332, 132 366, 164 378 Z"
BODY = "M146 404 C 132 352, 146 296, 176 262 C 190 246, 198 228, 204 212 C 214 214, 226 218, 236 222 C 236 250, 228 280, 220 310 C 212 345, 206 380, 196 404 C 178 420, 156 420, 146 404 Z"
HEAD = "M178 190 C 176 162, 202 146, 226 152 C 240 156, 250 172, 257 188 C 260 195, 256 200, 249 201 C 236 203, 222 208, 208 214 C 190 214, 179 204, 178 190 Z"
BIB = "M212 208 C 228 204, 240 214, 236 236 C 232 262, 222 284, 214 300 C 206 278, 200 248, 202 224 C 203 216, 206 210, 212 208 Z"
BROWN, TAILC, PAW, PINK, CREAM, INK = "#6b3f1f", "#5a3418", "#4e2c14", "#e8b48a", "#fbf1d9", "#22204a"

def render(size, bg=None, pad=0.0):
    W = size * S; im = Image.new("RGBA", (W, W), bg or (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    if bg: pass
    k = (W * (1 - 2 * pad)) / 512; o = W * pad
    T = lambda pts, mirror=False: [(o + ((512 - x) if mirror else x) * k, o + y * k) for x, y in pts]
    d.polygon(T(path_pts(HEART)), fill="#f2b705")
    for m in (False, True):
        d.polygon(T(path_pts(TAIL), m), fill=TAILC)
        d.polygon(T(path_pts(BODY), m), fill=BROWN)
        cx = lambda x: (512 - x) if m else x
        def circ(x, y, r, c): X, Y = o + cx(x) * k, o + y * k; d.ellipse([X - r*k, Y - r*k, X + r*k, Y + r*k], fill=c)
        def ell(x, y, rx, ry, c): X, Y = o + cx(x) * k, o + y * k; d.ellipse([X - rx*k, Y - ry*k, X + rx*k, Y + ry*k], fill=c)
        ell(204, 402, 17, 10, PAW)
        d.polygon(T(path_pts(EAR1), m), fill=BROWN); d.polygon(T(path_pts(EAR2), m), fill=BROWN)
        circ(194, 150, 5, PINK); circ(217, 141, 5, PINK)
        d.polygon(T(path_pts(HEAD), m), fill=BROWN)
        d.polygon(T(path_pts(BIB), m), fill=CREAM)
        circ(224, 172, 5.5, INK); circ(225.6 if not m else 222.4, 170.4, 1.8, "#ffffff"); circ(254, 191, 6, INK)
    return im.resize((size, size), Image.LANCZOS)

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    BRAND = "#2b2860"
    for s in (180, 192, 512):  # ikony aplikácie: srdce na tmavomodrom podklade
        render(s, BRAND, pad=0.1).convert("RGB").save(f"{out}/ikona-{s}.png")
    render(512).save(f"{out}/logo-512.png")
