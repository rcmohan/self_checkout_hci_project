"""Pack index.html, its stylesheet and scripts into one file.

    python tools/build_standalone.py           write dist/self-checkout-standalone.html
    python tools/build_standalone.py --check   fail if that file is out of date
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "dist" / "self-checkout-standalone.html"


def build():
    html = (ROOT / "index.html").read_text(encoding="utf-8")

    def style(match):
        css = (ROOT / match.group(1)).read_text(encoding="utf-8")
        return f"<style>\n{css}</style>"

    def script(match):
        code = (ROOT / match.group(1)).read_text(encoding="utf-8")
        code = code.replace("</script", "<\\/script")
        return f"<script>\n{code}</script>"

    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', style, html)
    html = re.sub(r'<script src="([^"]+)"></script>', script, html)
    return html


def main():
    text = build()
    if "--check" in sys.argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print("dist/ is out of date: run python tools/build_standalone.py")
            return 1
        print("dist/ is up to date")
        return 0
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({len(text):,} characters)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
