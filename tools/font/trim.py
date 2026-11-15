# The page's font trimmed to what the site draws: from tools/font/InterVariable-page.full.woff2 (the untrimmed Inter
# subset, with tools/share/font.mjs's private-use glyphs for the share card) it keeps
#   - the characters the page, its data and the share card can show: printable ASCII, Latin-1, the general punctuation
#     and dashes, the euro, the trade mark, the minus sign and the share card's private-use glyphs (U+E000 to E00B,
#     U+E010 to E01F); the Latin Extended-A letters go (no name on the site has one);
#   - the weight axis from 400 to 800, the weights the stylesheet asks for (the source's runs 100 to 900);
#   - every OpenType feature (the page's cv01, cv03, cv04, cv09, case, tnum, pnum, calt, locl and kern).
# 68 KB came out 44 KB. Every advance width is the same at every weight; at 400 every outline is the same, and from 500
# to 800 the narrower axis re-rounds its deltas, moving outline points by at most one font unit (0.04 px on the 80 px
# headline). Writing it also runs tools/share/font.mjs, which re-derives the share card's private-use glyphs from the
# trimmed font and owns the served file's final bytes.
# Usage: tools/.venv/bin/python tools/font/trim.py           writes src/web/public/fonts/InterVariable-page.woff2
#        tools/.venv/bin/python tools/font/trim.py --check   exits 1 unless the served font holds exactly these
#                                                            characters and weights (font.mjs --check owns the rest)
# (python3 -m venv tools/.venv && tools/.venv/bin/pip install fonttools brotli, once)
import io, os, subprocess, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'InterVariable-page.full.woff2')
OUT = os.path.join(HERE, '../../src/web/public/fonts/InterVariable-page.woff2')
KEEP = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + list(range(0x2010, 0x2028)) + list(range(0x2030, 0x203B))
        + [0x20AC, 0x2122, 0x2212] + list(range(0xE000, 0xE00C)) + list(range(0xE010, 0xE020)))

def trimmed():
    o = subset.Options()
    o.layout_features = ['*']; o.name_IDs = ['*']; o.name_languages = ['*']; o.notdef_outline = True
    o.hinting = False; o.desubroutinize = True; o.passthrough_tables = True
    f = TTFont(SRC, recalcTimestamp=False)
    s = subset.Subsetter(o); s.populate(unicodes=KEEP); s.subset(f)
    f = instancer.instantiateVariableFont(f, {'wght': (400, 800)})
    f.recalcTimestamp = False
    f.flavor = 'woff2'
    buf = io.BytesIO(); f.save(buf, reorderTables=False)
    return buf.getvalue()

if '--check' in sys.argv:
    f = TTFont(OUT)
    have = set(f.getBestCmap())
    wght = [(a.minValue, a.maxValue) for a in f['fvar'].axes if a.axisTag == 'wght']
    want = set(KEEP) & set(TTFont(SRC).getBestCmap())  # the source has no soft hyphen (U+00AD), for one
    if have != want or wght != [(400.0, 800.0)]:
        print('the served font is not the trimmed one (tools/.venv/bin/python tools/font/trim.py)'); sys.exit(1)
    print(f'the served font is trimmed ({os.path.getsize(OUT)} bytes, {len(have)} characters, weights 400 to 800)')
else:
    data = trimmed()
    open(OUT, 'wb').write(data)
    subprocess.run(['node', os.path.join(HERE, '../share/font.mjs')], check=True, stdout=subprocess.DEVNULL)
    print(f'{os.path.getsize(SRC)} -> {os.path.getsize(OUT)} bytes, share card glyphs patched')
