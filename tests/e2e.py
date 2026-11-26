"""End-to-end tests that drive the real interface with mouse, touch and keyboard.

    python tests/e2e.py                      test index.html and the standalone file
    python tests/e2e.py --sample PATH        also save one study export to PATH
"""
import base64
import gzip
import json
import pathlib
import sys
import time

from cdp import Browser

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from decode_export import decode
TARGETS = [ROOT / "index.html", ROOT / "dist" / "self-checkout-standalone.html"]
RESULTS = []


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition)))
    print(("pass " if condition else "FAIL ") + name + ("" if condition else f"  {detail}"))


def action(name, **params):
    """CSS selector for the button that dispatches `name` with these params."""
    selector = f'[data-action="{name}"]'
    for key, value in params.items():
        encoded = json.dumps({key: value}, separators=(",", ":"))[1:-1]
        selector += f"[data-params*='{encoded}']"
    return selector


def ui(command, value=None):
    return f'[data-ui="{command}"]' + (f'[data-value="{value}"]' if value is not None else "")


class Kiosk:
    def __init__(self, browser):
        self.b = browser
        self.use_touch = False

    def press(self, selector):
        (self.b.tap if self.use_touch else self.b.click)(selector)

    def state(self, expression):
        return self.b.js(f"(() => {{ const s = SCO.app.getState(); return {expression}; }})()")

    def screen(self, name):
        self.b.wait(f"SCO.app.getState().ui.screen === '{name}'")

    def line(self, sku):
        return self.state(f"s.lines.filter(l => l.sku === '{sku}')[0].lineId")

    def idle(self):
        self.b.wait("SCO.app.getState().requests.every(r => r.phase !== 'verifying')")

    def physical(self):
        """Press every highlighted step in the simulation panel."""
        while self.b.js("!!document.querySelector('.dock [data-action=\"physical.confirm\"]')"):
            self.press('.dock [data-action="physical.confirm"]')
            self.idle()

    def scan(self, sku):
        self.press(action("scan.item", simItemId=sku))

    def add(self, sku):
        self.scan(sku)
        self.physical()

    def start(self):
        """Start a session and dismiss the first-run tips."""
        self.press(ui("start"))
        self.press(ui("tour-skip"))

    def start_task(self):
        self.press(action("task.start"))

    def done(self):
        self.press(action("task.done"))

    def export(self):
        return json.loads(self.b.js("SCO.app.getExport().compact"))


def fresh(browser, url, speed=True):
    browser.goto(url)
    browser.js("window.localStorage.clear()")
    browser.reload()
    if speed:
        speed_up(browser)


def speed_up(browser):
    browser.js("Object.assign(SCO.app.config.delays, {verificationMs: 80, assistanceMs: 150, paymentMs: 150})")


def study_session(browser, k, url, label, sample=None):
    fresh(browser, url)
    check(f"{label}: nothing recorded or stored before Start", browser.js(
        "SCO.app.getEvents().length === 0 && !localStorage.getItem('sco.session.v1')"))
    k.start()
    k.screen("task_ready")

    k.start_task()                                  # T1: direct quantity entry on the keypad
    k.press(action("kiosk.start"))
    k.add("soup")
    k.press(action("qty.open"))
    k.press(ui("key", "3"))
    k.press('[data-fk="submit"]')
    check(f"{label}: requested quantity shown while committed is unchanged", k.state(
        "s.lines[0].qty === 1 && document.querySelector('.badge-pending').textContent.includes('Requested 3 (charged for 1)')"))
    k.physical()
    k.done()

    k.start_task()                                  # T2: the existing duplicate prompt
    k.screen("help")
    k.press(action("help.choose", option="remove_duplicate"))
    k.idle()
    k.done()

    k.start_task()                                  # T3: trash on an older row that must be scrolled to
    k.press(f'[data-action="remove.open"][aria-label="Remove Whole Milk, 1 gal"]')
    k.press(action("remove.confirm", reason="unwanted"))
    k.physical()
    k.done()

    k.start_task()                                  # T4: unreadable barcode, manual entry
    k.scan("cereal")
    k.screen("help")
    k.press(action("help.choose", option="enter_code"))
    for digit in "100105":
        k.press(ui("key", digit))
    k.press('[data-fk="submit"]')
    k.physical()
    k.done()

    k.start_task()                                  # T5: produce search and weighing
    k.press(action("lookup.open"))
    browser.js("document.querySelector('[data-search]').focus()")
    browser.send("Input.insertText", text="gala")
    time.sleep(0.1)
    check(f"{label}: produce search filters tiles", browser.js(
        "document.querySelectorAll('.tiles li:not([hidden])').length === 1"))
    k.press(action("lookup.select", sku="gala_apples"))
    k.press(action("scale.place"))
    k.press(action("weigh.confirm"))
    k.physical()
    k.done()

    k.start_task()                                  # T6: set aside, scan another, resolve, pay
    k.press(action("kiosk.start"))
    k.scan("paper_towels")
    k.press(action("help.choose", option="set_aside"))
    k.add("juice")
    check(f"{label}: blocked Pay explains why and links to Needs attention", k.state(
        "document.querySelector('.btn-pay').getAttribute('aria-disabled') === 'true' && !!document.querySelector('[data-ui=goto-attention]')"))
    k.press(".btn-pay")
    k.press(ui("goto-attention"))
    check(f"{label}: Needs attention link moves focus to Resolve", browser.js(
        "document.activeElement.classList.contains('btn-resolve')"))
    k.press(".attention .btn-resolve")
    k.press(action("help.choose", option="request_assistance"))
    k.screen("assistance")
    k.press(action("nav.back"))
    browser.wait("SCO.tx.unresolved(SCO.app.getState()).length === 0")
    k.physical()
    k.press(".btn-pay")
    k.press(action("pay.method", method="credit"))
    k.press(action("pay.tender"))
    k.screen("payment_complete")
    k.press(action("receipt.choose", option="print"))
    k.press(action("receipt.done"))
    k.screen("results")

    doc = k.export()
    outcomes = [t["outcome"] for t in doc["tasks"]]
    check(f"{label}: all six tasks succeed through the interface", outcomes == ["success"] * 6, outcomes)
    check(f"{label}: session completed with no participant or technical errors",
          doc["status"] == "completed" and doc["summary"]["participantErrors"] == 0
          and doc["summary"]["errorsByCategory"]["technical"] == 0, doc["summary"]["errorsByCategory"])
    check(f"{label}: event sequence ordered", [e["seq"] for e in doc["events"]] == list(range(1, len(doc["events"]) + 1)))
    check(f"{label}: blocked payment recorded once", doc["summary"]["blockedPayments"] == 1)
    check(f"{label}: search text is not logged", '"gala"' not in json.dumps(doc["events"]))
    print(f"     export size: {len(json.dumps(doc, separators=(',', ':'))):,} characters, {len(doc['events'])} events")
    if sample:
        pathlib.Path(sample).write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
    return doc


def results_screen(browser, k, label):
    compact = browser.js("SCO.app.getExport().compact")
    browser.wait("SCO.app.getExport().paste !== null && document.getElementById('json').value !== ''")
    paste = browser.js("SCO.app.getExport().paste")
    wrapper = json.loads(paste)
    print(f"     compressed: {len(paste):,} characters from {len(compact):,}")
    check(f"{label}: results text area holds the compressed JSON", browser.js("document.getElementById('json').value") == paste
          and wrapper["encoding"] == "gzip+base64" and wrapper["sessionId"] == json.loads(compact)["sessionId"])
    check(f"{label}: compressed form is under a quarter of the size", len(paste) < len(compact) / 4, (len(paste), len(compact)))
    check(f"{label}: compressed form decodes to exactly the same data",
          gzip.decompress(base64.b64decode(wrapper["data"])).decode("utf-8") == compact and decode(paste) == json.loads(compact))
    wrapped = "\n".join(paste[i:i + 76] for i in range(0, len(paste), 76))
    check(f"{label}: decoder accepts line-wrapped and plain responses",
          decode(wrapped) == decode(compact) == json.loads(compact))
    try:
        decode(paste[:-200])
        rejected = False
    except ValueError:
        rejected = True
    check(f"{label}: decoder rejects a truncated response", rejected)
    check(f"{label}: label states the compressed length", browser.js(
        "document.getElementById('json-label').textContent") .startswith(f"Compressed session JSON ({len(paste):,} characters)"))
    browser.js("window.__copied = null; Object.defineProperty(navigator, 'clipboard', {configurable: true, value: "
               "{writeText: t => { window.__copied = t; return Promise.resolve(); }}})")
    k.press(ui("copy"))
    browser.wait("document.getElementById('copy-status').textContent.includes('Copied')")
    check(f"{label}: copy puts the compressed JSON on the clipboard", browser.js("window.__copied") == paste)
    browser.js("Object.defineProperty(navigator, 'clipboard', {configurable: true, value: "
               "{writeText: () => Promise.reject(new Error('denied'))}}); document.execCommand = () => false")
    k.press(ui("copy"))
    browser.wait("document.getElementById('copy-status').textContent.includes('did not work')")
    check(f"{label}: failed copy selects the text and shows no success", browser.js(
        "(() => { const t = document.getElementById('json'); return t.selectionStart === 0 && t.selectionEnd === t.value.length "
        "&& !document.getElementById('copy-status').textContent.includes('Copied'); })()"))
    k.press(ui("download"))
    k.press(ui("download"))
    name = "self-checkout-session-" + json.loads(compact)["sessionId"] + ".json"
    path = pathlib.Path(browser.downloads) / name
    for _ in range(100):
        if path.exists():
            break
        time.sleep(0.1)
    check(f"{label}: download uses the session file name and formatted JSON",
          path.exists() and "\n  " in path.read_text(encoding="utf-8")
          and json.loads(path.read_text(encoding="utf-8")) == json.loads(compact))
    check(f"{label}: export unchanged after repeated copy and download",
          browser.js("[SCO.app.getExport().compact, SCO.app.getExport().paste]") == [compact, paste])
    browser.reload()
    browser.wait("SCO.app.getExport().paste !== null")
    check(f"{label}: compressed text is identical after reload", browser.js("document.getElementById('json').value") == paste)
    check(f"{label}: finished session survives reload unchanged",
          browser.js("SCO.app.getState().ui.screen") == "results" and browser.js("SCO.app.getExport().compact") == compact)
    k.press(ui("ask-delete"))
    k.press(ui("confirm-no"))
    check(f"{label}: delete needs confirmation", browser.js("!!localStorage.getItem('sco.session.v1')"))
    k.press(ui("ask-delete"))
    k.press(ui("confirm-yes"))
    check(f"{label}: delete clears storage and returns to the notice", browser.js(
        "!localStorage.getItem('sco.session.v1') && SCO.app.getState().ui.screen === 'intro'"))


def reload_resume(browser, k, url):
    fresh(browser, url)
    browser.js("document.querySelector('input[value=practice]').click()")
    k.start()
    k.press(action("kiosk.start"))
    k.add("milk")
    first = browser.js("SCO.app.getSessionId()")
    browser.js("SCO.app.config.delays.assistanceMs = 60000")
    k.press(action("assist.request"))
    browser.reload()
    speed_up(browser)
    check("reload offers Resume or Discard", browser.js(
        "!!document.querySelector('[data-ui=resume]') && !!document.querySelector('[data-ui=ask-delete]') && !document.querySelector('[data-ui=start]')"))
    browser.js("SCO.app.config.delays.assistanceMs = 150")
    k.press(ui("resume"))
    browser.wait("SCO.tx.unresolved(SCO.app.getState()).length === 0")
    check("resume keeps the session, logs it and restarts timers", browser.js(
        f"SCO.app.getSessionId() === '{first}' && SCO.app.getEvents().filter(e => e.type === 'session_resumed').length === 1"
        " && SCO.app.getState().lines.length === 1"))
    browser.js("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});"
               "document.dispatchEvent(new Event('visibilitychange'))")
    check("tab visibility is recorded", browser.js("SCO.app.getEvents().some(e => e.type === 'visibility_changed')"))
    browser.reload()
    k.press(ui("ask-delete"))
    k.press(ui("confirm-yes"))
    speed_up(browser)
    k.start()
    check("discard then start gives a distinct session", browser.js(f"SCO.app.getSessionId() !== '{first}'"))
    k.press(ui("ask-end"))
    k.press(ui("confirm-yes"))
    k.screen("results")
    check("an incomplete study session exports as abandoned", k.export()["status"] == "abandoned")


def storage_disabled(browser, k, url):
    script = browser.send("Page.addScriptToEvaluateOnNewDocument", source=(
        "Object.defineProperty(window, 'localStorage', {configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); }});"))
    browser.goto(url)
    speed_up(browser)
    check("storage disabled: a warning is shown", browser.js(
        "document.querySelector('.warning') && document.querySelector('.warning').textContent.includes('may lose')"))
    k.start()
    k.start_task()
    k.press(action("kiosk.start"))
    k.add("soup")
    k.press(ui("ask-end"))
    k.press(ui("confirm-yes"))
    check("storage disabled: the session still exports", k.export()["status"] == "abandoned")
    browser.send("Page.removeScriptToEvaluateOnNewDocument", identifier=script["identifier"])


def keyboard(browser, k, url):
    fresh(browser, url)

    def focused():
        return browser.js("(() => { const e = document.activeElement; return (e.getAttribute('data-action') || e.getAttribute('data-ui') || e.tagName) + ' ' + (e.getAttribute('data-params') || ''); })()")

    def tab_to(selector, limit=80):
        for _ in range(limit):
            if browser.js(f"document.activeElement.matches({json.dumps(selector)})"):
                return True
            browser.key("Tab", "Tab", 9)
        raise AssertionError(f"Tab never reached {selector}; stopped on {focused()}")

    def enter():
        browser.key("Enter", "Enter", 13, text="\r")

    def activate(selector):
        tab_to(selector)
        enter()

    activate(ui("start"))
    browser.key("Escape", "Escape", 27)
    activate(action("task.start"))
    activate(action("kiosk.start"))
    activate(action("scan.item", simItemId="soup"))
    activate('.dock [data-action="physical.confirm"]')
    k.idle()
    activate(action("qty.open"))
    check("keyboard: quantity editor focuses its field", browser.js("document.activeElement.id === 'entry'"))
    browser.send("Input.insertText", text="3")
    enter()
    activate('.dock [data-action="physical.confirm"]')
    k.idle()
    check("keyboard: quantity 1 to 3 completes with the keyboard only", k.state("s.lines[0].qty === 3"))
    tab_to(action("remove.open"))
    ring = browser.js("getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth")
    check("keyboard: focus ring is visible", ring.startswith("solid") and ring.endswith("3px"), ring)
    browser.key(" ", "Space", 32, text=" ")
    k.screen("removal_confirm")
    browser.key("Escape", "Escape", 27)
    k.screen("checkout")
    check("keyboard: Escape cancels without changing the order", k.state("s.lines.length === 1 && s.requests.length === 0"))
    activate(ui("ask-end"))
    check("keyboard: confirmation dialog takes focus and blocks the page", browser.js(
        "document.activeElement.dataset.ui === 'confirm-no' && document.querySelector('.app').inert === true"))
    browser.key("Escape", "Escape", 27)
    check("keyboard: Escape closes the confirmation", browser.js("!document.querySelector('.overlay')"))


def double_tap(browser, k, url):
    fresh(browser, url)
    browser.js("document.querySelector('input[value=practice]').click()")
    k.start()
    k.press(action("kiosk.start"))
    k.add("eggs")
    x, y = browser.center(".btn-pay")
    for count in (1, 2):
        for kind in ("mousePressed", "mouseReleased"):
            browser.send("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=count)
    time.sleep(0.1)
    check("double tap on Pay does not choose a payment method", k.state("s.ui.screen === 'payment_method'"),
          k.state("s.ui.screen"))


def layout(browser, k, url):
    fresh(browser, url)
    browser.js("document.querySelector('input[value=practice]').click()")
    browser.viewport(1366, 768)
    k.press(ui("start"))
    k.press(ui("tour-next"))
    layout_tip = browser.js("document.querySelector('.tour-card').innerText")
    check("tips: practice mode shows them too", "Your items are here" in layout_tip, layout_tip)
    tip_problems = browser.js("[...document.querySelectorAll('.tour-card button')].filter(e => e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44).length")
    check("touch targets at least 44px on the tips", tip_problems == 0, tip_problems)
    k.press(ui("tour-skip"))
    k.press(action("kiosk.start"))
    for sku in ["eggs", "milk", "bread", "juice", "cereal", "soup"]:
        k.add(sku)
    for sim in ["paper_towels", "unknown_snack", "wine"]:
        k.scan(sim)
        k.press(action("help.choose", option="set_aside"))
    visible = ("(() => { const a = document.querySelector('.attention').getBoundingClientRect(), l = document.querySelector('.list').getBoundingClientRect(),"
               " t = document.querySelector('.totals').getBoundingClientRect(), k = document.querySelector('.kiosk').getBoundingClientRect(),"
               " r = document.querySelector('.list tbody tr').offsetHeight, h = document.querySelector('.list thead').offsetHeight;"
               " return {anchored: a.top >= l.bottom - 1 && a.bottom <= t.top + 1 && t.bottom <= k.bottom, top: a.top,"
               " rows: (l.height - h) / r, scrolls: document.querySelector('.list').scrollHeight > l.height}; })()")
    for width, height in [(1366, 768), (1920, 1080), (1280, 720), (1024, 768)]:
        browser.viewport(width, height)
        time.sleep(0.1)
        before = browser.js(visible)
        browser.js("document.querySelector('.list').scrollTop = 0")
        browser.js("document.querySelector('.list').scrollTop = 9999")
        after = browser.js(visible)
        check(f"{width}x{height}: Needs attention stays anchored while the list scrolls",
              before["anchored"] and after["anchored"] and before["top"] == after["top"], (before, after))
        check(f"{width}x{height}: at least 1.7 item rows remain visible", after["rows"] >= 1.7, after["rows"])
        check(f"{width}x{height}: no page scrolling needed", browser.js(
            "document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight"))
    check("status is conveyed by text and icon, not colour alone", browser.js(
        "[...document.querySelectorAll('.attention .status')].every(e => e.textContent.trim().length > 3 && e.querySelector('[aria-hidden]'))"))

    small = ("[...document.querySelectorAll('button, a.btn, .choice')].filter(e => e.offsetParent)"
             ".map(e => { const r = e.getBoundingClientRect(); return {t: (e.getAttribute('aria-label') || e.textContent).trim().slice(0,40), w: Math.round(r.width), h: Math.round(r.height)}; })"
             ".filter(x => x.w < 44 || x.h < 44)")
    unnamed = ("[...document.querySelectorAll('button, input, textarea')].filter(e => !(e.getAttribute('aria-label') || e.textContent.trim() ||"
               " (e.labels && e.labels.length))).map(e => e.outerHTML.slice(0,100))")

    # WCAG contrast of visible text against the nearest opaque background (4.5:1, or 3:1 for large text).
    faint = r'''(() => {
      const rgb = c => (c.match(/[\d.]+/g) || []).map(Number);
      const lum = c => { const [r,g,b] = c.slice(0,3).map(v => { v /= 255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }); return .2126*r + .7152*g + .0722*b; };
      const background = e => { for (; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || c[3] > 0) return c; } return [255,255,255]; };
      const found = [];
      for (const e of document.querySelectorAll('body *')) {
        if (!e.offsetParent || e.closest('.sr-only, [aria-hidden]') || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
        const s = getComputedStyle(e), a = lum(rgb(s.color)), b = lum(background(e));
        const ratio = (Math.max(a,b)+.05) / (Math.min(a,b)+.05);
        const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
        if (ratio < (large ? 3 : 4.5)) found.push(e.textContent.trim().slice(0,30) + ' ' + ratio.toFixed(2));
      }
      return found;
    })()'''

    def audit(name):
        found = browser.js(faint)
        check(f"text contrast on {name}", not found, found[:6])
        found = browser.js(small)
        check(f"touch targets at least 44px on {name}", not found, found[:6])
        found = browser.js(unnamed)
        check(f"controls have accessible names on {name}", not found, found[:4])

    browser.viewport(1024, 768, touch=True)
    audit("checkout")
    k.use_touch = True
    k.press(".attention .btn-resolve")
    audit("issue help")
    k.press(action("nav.back"))
    k.press('[data-action="qty.open"][aria-label^="Edit quantity of Whole Milk"]')
    audit("quantity editor")
    k.press(ui("key", "2"))
    k.press('[data-fk="submit"]')
    k.physical()
    check("touch: quantity change completes", k.state("s.lines.filter(l => l.sku === 'milk')[0].qty === 2"))
    k.press(action("help.open"))
    audit("general help")
    k.press(action("nav.back"))
    k.press(action("lookup.open"))
    audit("produce lookup")
    k.press(action("nav.back"))
    k.use_touch = False

    browser.viewport(390, 844)
    time.sleep(0.15)
    check("phone width: no horizontal scrolling", browser.js(
        "document.documentElement.scrollWidth <= innerWidth && document.querySelector('.list').scrollWidth <= document.querySelector('.list').clientWidth + 1"))
    audit("phone checkout")
    browser.viewport(1366, 768)


TOUR_GEOMETRY = r"""(() => {
  const card = document.querySelector('.tour-card').getBoundingClientRect();
  const spot = document.querySelector('.tour-spot').getBoundingClientRect();
  const titles = ['.dock', '.dock [data-tour="basket"]', '.dock [data-tour="next"]'];
  const n = Number(document.querySelector('.tour-count').textContent.match(/\d+/)[0]) - 1;
  const t = document.querySelector(titles[n]).getBoundingClientRect();
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return {inside: card.left >= 0 && card.top >= 0 && card.right <= innerWidth + 1 && card.bottom <= innerHeight + 1,
          covered: overlap(card, spot), lit: overlap(spot, t) / Math.min(t.width * t.height, spot.width * spot.height),
          height: spot.height};
})()"""


def tips(browser, k, url):
    for width, height in [(1366, 768), (1920, 1080), (1024, 768), (800, 900), (390, 844)]:
        browser.viewport(width, height)
        fresh(browser, url)
        k.press(ui("start"))
        for step in (1, 2, 3):
            time.sleep(0.15)
            g = browser.js(TOUR_GEOMETRY)
            check(f"{width}x{height}: tip {step} is on screen, beside its highlighted target",
                  g["inside"] and g["covered"] < 1 and g["lit"] > 0.6 and g["height"] >= 40, g)
            if step < 3:
                k.press(ui("tour-next"))
    browser.viewport(1366, 768)
    fresh(browser, url)
    k.press(ui("start"))
    check("tips: first start shows tip 1 with the panel behind it and the page blocked", browser.js(
        "document.querySelector('.tour-count').textContent === 'Tip 1 of 3' && !!document.querySelector('.dock')"
        " && document.querySelector('.app').inert === true && document.activeElement.dataset.ui === 'tour-next'"))
    check("tips: dialog is named and announced", browser.js(
        "document.querySelector('[role=dialog][aria-labelledby=tour-title]') !== null"))
    k.press(ui("tour-next"))
    check("tips: Next advances and keeps focus", browser.js(
        "document.querySelector('.tour-count').textContent === 'Tip 2 of 3' && document.activeElement.dataset.ui === 'tour-next'"))
    k.press(ui("tour-back"))
    check("tips: Back returns", browser.js("document.querySelector('.tour-count').textContent === 'Tip 1 of 3'"))
    browser.reload()
    k.press(ui("resume"))
    check("tips: unfinished tips return after a reload", browser.js("!!document.querySelector('.tour')"))
    k.press(ui("tour-next"))
    k.press(ui("tour-next"))
    check("tips: last tip shows the example yellow button", browser.js("!!document.querySelector('.sim-example')"))
    k.press(ui("tour-next"))
    check("tips: Got it leads to the first task card with no task running", k.state(
        "s.ui.screen === 'task_ready' && !s.tasks.activeId && !document.querySelector('.tour') && !document.querySelector('.app').inert"))
    check("tips: completion is recorded", browser.js(
        "SCO.app.getEvents().filter(e => e.type === 'tour_finished' && e.details.result === 'completed' && e.details.stepsViewed === 3).length === 1"))
    k.start_task()
    check("tips: example button is gone during the task", browser.js(
        "!document.querySelector('.tour') && !document.querySelector('.sim-example')"))
    browser.reload()
    k.press(ui("resume"))
    check("tips: finished tips do not return after a reload", browser.js("!document.querySelector('.tour')"))


def no_compression(browser, k, url):
    script = browser.send("Page.addScriptToEvaluateOnNewDocument", source="delete window.CompressionStream;")
    fresh(browser, url)
    k.start()
    k.press(ui("ask-end"))
    k.press(ui("confirm-yes"))
    browser.wait("SCO.app.getExport().paste !== null")
    check("without compression support the plain JSON is offered", browser.js(
        "document.getElementById('json').value === SCO.app.getExport().compact"
        " && document.getElementById('json-label').textContent.startsWith('Session JSON (')"))
    browser.send("Page.removeScriptToEvaluateOnNewDocument", identifier=script["identifier"])


def scan_again(browser, k, url):
    fresh(browser, url)
    browser.js("document.querySelector('input[value=practice]').click()")
    k.start()
    k.press(action("kiosk.start"))
    k.press(action("sim.unexpected_item"))
    if k.state("s.ui.screen") != "help":
        k.press(".attention .btn-resolve")
    k.press(action("help.choose", option="scan_again"))
    check("Scan again: kiosk and panel say what to do next", browser.js(
        "document.querySelector('.prompt-title').textContent === 'Scan the item now'"
        " && !!document.querySelector('.dock .sim-note')"
        " && document.querySelector('.attention').textContent.includes('Waiting for you to scan')"))
    k.scan("soup")
    k.physical()
    check("Scan again: scanning clears the bagging problem", k.state(
        "SCO.tx.unresolved(s).length === 0 && s.lines.length === 1 && !document.querySelector('.sim-note')"))


def next_step_visible(browser, k, url):
    in_view = ("""(() => { const el = document.querySelector('.dock .sim-next'), d = document.querySelector('.dock');
      if (!el) return false; const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return d.scrollTop > 0 && !!hit && el.contains(hit) && !!document.querySelector('.kiosk .sim-hint'); })()""")
    for width, height in [(1366, 768), (1920, 1080), (1024, 700)]:
        browser.viewport(width, height)
        fresh(browser, url)
        browser.js("document.querySelector('input[value=practice]').click()")
        k.start()
        k.press(action("kiosk.start"))
        k.press(action("sim.unexpected_item"))  # at the bottom of the panel, so it scrolls
        k.press(action("help.choose", option="remove_from_bagging"))
        check(f"{width}x{height}: yellow button stays visible in a scrolled panel, and the kiosk points to it",
              browser.js(in_view))
        k.press('.dock [data-action="physical.confirm"]')
        k.idle()
        check(f"{width}x{height}: pressing it clears the unexpected item",
              k.state("SCO.tx.unresolved(s).length === 0"))
    browser.viewport(1366, 768)


def url_options(browser, k, url):
    fresh(browser, url + "?order=T3,T1,T2,T4,T5,T6")
    k.start()
    check("?order= sets the task order", k.state("s.tasks.order.join()") == "T3,T1,T2,T4,T5,T6")
    k.press(ui("ask-end"))
    k.press(ui("confirm-yes"))


def standalone_is_current():
    sys.path.insert(0, str(ROOT / "tools"))
    from build_standalone import OUTPUT, build
    check("standalone file matches the current source",
          OUTPUT.exists() and OUTPUT.read_text(encoding="utf-8") == build())


def main():
    standalone_is_current()
    sample = sys.argv[sys.argv.index("--sample") + 1] if "--sample" in sys.argv else None
    browser = Browser()
    try:
        k = Kiosk(browser)
        for index, target in enumerate(TARGETS):
            url = target.as_uri()
            label = "standalone" if index else "index.html"
            browser.viewport(1366, 768)
            study_session(browser, k, url, label, sample if index == 0 else None)
            results_screen(browser, k, label)
        url = TARGETS[0].as_uri()
        for part in (reload_resume, keyboard, double_tap, layout, tips, url_options, no_compression, scan_again, next_step_visible, storage_disabled):
            try:
                part(browser, k, url)
            except Exception as error:  # report and continue with the other groups
                check(f"{part.__name__} ran to completion", False, repr(error))
                k.use_touch = False
        external = [r for r in browser.requests if not r.startswith(("file:", "data:", "about:", "blob:"))]
        check("no network requests", not external, external[:5])
        check("no page errors", not browser.errors, browser.errors[:5])
    finally:
        browser.close()
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\n{passed} of {len(RESULTS)} checks passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
