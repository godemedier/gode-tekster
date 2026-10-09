# Programikonet »Tom side« (8/10): et blankt ark på en blækplade og én vermilion markør.
# Tegnes her i stedet for at skaleres ned fra én stor fil: 16, 20, 24 og 32 px har hver deres
# håndtegnede udgave på pixelgitteret, så arket og markøren står skarpt ved uret og i proceslinjen.
#
#   python scripts/ikon.py          skriver src-tauri/icons/kilde-1024.png og icon.ico
#   npx tauri icon src-tauri/icons/kilde-1024.png   laver de øvrige størrelser (kør FØR denne igen,
#                                                   fordi tauri icon overskriver icon.ico og 32x32.png)
from pathlib import Path

from PIL import Image, ImageDraw

INK, EDGE, PAPER, VERMILION = "#1d2125", "#353b42", "#f5f6f7", "#db5230"
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"

# Hver tegning i sit eget gitter: (gitter, pladens hjørne, kantbredde, arket, markøren).
# Arket og markøren er (x0, y0, x1, y1, hjørne). Store størrelser bruger 256-tegningen.
DRAWINGS = {
    16: (16, 4, 1, (4, 2, 12, 14, 1), (6, 4, 8, 8, 0)),
    20: (20, 4.5, 1, (5, 2, 15, 18, 1), (7, 5, 9, 10, 0)),
    24: (24, 5.5, 1, (6, 3, 18, 21, 1.5), (9, 6, 11, 12, 0)),
    32: (32, 7, 1, (8, 5, 24, 27, 1.5), (11, 8, 13, 16, 0)),
    256: (256, 57, 4, (68, 40, 188, 216, 12), (90, 62, 110, 134, 10)),
}


def draw(size: int) -> Image.Image:
    grid, radius, edge, sheet, caret = DRAWINGS.get(size, DRAWINGS[256])
    ss = 16 if size <= 64 else 4  # tegnes stort og skaleres ned, så kun skrå kanter bliver bløde
    scale = size * ss / grid
    im = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = lambda v: v * scale  # noqa: E731
    full = size * ss - 1
    d.rounded_rectangle((0, 0, full, full), s(radius), fill=EDGE)
    d.rounded_rectangle((s(edge), s(edge), full - s(edge), full - s(edge)), s(radius - edge), fill=INK)
    for (x0, y0, x1, y1, r), color in ((sheet, PAPER), (caret, VERMILION)):
        d.rounded_rectangle((s(x0), s(y0), s(x1) - 1, s(y1) - 1), s(r), fill=color)
    return im.resize((size, size), Image.Resampling.BOX)


if __name__ == "__main__":
    draw(1024).save(OUT / "kilde-1024.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    images = [draw(n) for n in sizes]
    images[-1].save(OUT / "icon.ico", sizes=[(n, n) for n in sizes], append_images=images[:-1])
    draw(32).save(OUT / "32x32.png")
    print("skrevet:", ", ".join(f"{n} px" for n in sizes))
