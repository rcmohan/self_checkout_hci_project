"""Minimal Chrome DevTools Protocol driver for the browser tests.

Needs Chrome or Edge, and the `websockets` package (pip install websockets).
Set the CHROME environment variable to use a browser in another location.
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request

from websockets.sync.client import connect

CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome"),
    shutil.which("chromium"),
]


class Browser:
    def __init__(self):
        exe = next((c for c in CANDIDATES if c and os.path.exists(c)), None)
        if not exe:
            raise RuntimeError("No Chrome or Edge found. Set the CHROME environment variable.")
        self.profile = tempfile.mkdtemp(prefix="sco-test-")
        self.downloads = tempfile.mkdtemp(prefix="sco-dl-")
        self.proc = subprocess.Popen(
            [exe, "--headless=new", "--remote-debugging-port=0", "--no-first-run",
             "--no-default-browser-check", "--disable-background-networking",
             "--disable-component-update",
             f"--user-data-dir={self.profile}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = os.path.join(self.profile, "DevToolsActivePort")
        for _ in range(200):
            if os.path.exists(port_file) and open(port_file).read().strip():
                break
            time.sleep(0.1)
        port = open(port_file).read().split()[0]
        for _ in range(50):
            pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
            pages = [p for p in pages if p["type"] == "page"]
            if pages:
                break
            time.sleep(0.1)
        self.ws = connect(pages[0]["webSocketDebuggerUrl"], max_size=None)
        self.counter = 0
        self.requests = []
        self.errors = []
        for domain in ("Page", "Runtime", "Network", "Log"):
            self.send(f"{domain}.enable")
        self.send("Browser.setDownloadBehavior", behavior="allow", downloadPath=self.downloads)

    def send(self, method, **params):
        self.counter += 1
        mine = self.counter
        self.ws.send(json.dumps({"id": mine, "method": method, "params": params}))
        while True:
            message = json.loads(self.ws.recv(timeout=60))
            if message.get("id") == mine:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            self._event(message)

    def _event(self, message):
        method = message.get("method")
        params = message.get("params", {})
        if method == "Network.requestWillBeSent":
            self.requests.append(params["request"]["url"])
        elif method == "Runtime.exceptionThrown":
            detail = params["exceptionDetails"]
            self.errors.append(detail.get("exception", {}).get("description") or detail.get("text"))
        elif method == "Runtime.consoleAPICalled" and params.get("type") == "error":
            self.errors.append(" ".join(str(a.get("value") or a.get("description")) for a in params["args"]))
        elif method == "Log.entryAdded" and params["entry"]["level"] == "error":
            self.errors.append(params["entry"]["text"])

    def js(self, expression):
        result = self.send("Runtime.evaluate", expression=expression, returnByValue=True,
                           awaitPromise=True, userGesture=True)
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            raise RuntimeError(detail.get("exception", {}).get("description") or detail["text"])
        return result["result"].get("value")

    def goto(self, url):
        self.send("Page.navigate", url=url)
        self.wait("document.readyState === 'complete'")
        time.sleep(0.15)

    def reload(self):
        self.send("Page.reload", ignoreCache=True)
        time.sleep(0.3)
        self.wait("document.readyState === 'complete'")
        time.sleep(0.15)

    def wait(self, expression, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.js(expression):
                    return True
            except RuntimeError:
                pass
            time.sleep(0.05)
        raise AssertionError(f"Timed out waiting for: {expression}")

    def viewport(self, width, height, touch=False):
        self.send("Emulation.setDeviceMetricsOverride", width=width, height=height,
                  deviceScaleFactor=1, mobile=False)
        self.send("Emulation.setTouchEmulationEnabled", enabled=touch)

    def center(self, selector):
        """Scroll an element into view and return its centre, checking it is hittable."""
        quoted = json.dumps(selector)
        self.wait(f"!!document.querySelector({quoted})")
        point = self.js(f"""(() => {{
          const el = document.querySelector({quoted});
          el.scrollIntoView({{block:'nearest', inline:'nearest'}});
          const r = el.getBoundingClientRect();
          const x = r.left + r.width/2, y = r.top + r.height/2;
          const hit = document.elementFromPoint(x, y);
          return {{x, y, hit: !!hit && (el === hit || el.contains(hit)),
                   over: hit ? hit.outerHTML.slice(0,120) : null}};
        }})()""")
        if not point["hit"]:
            raise AssertionError(f"{selector} is covered or off screen by {point['over']}")
        return point["x"], point["y"]

    def click(self, selector):
        x, y = self.center(selector)
        for kind in ("mousePressed", "mouseReleased"):
            self.send("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)
        time.sleep(0.03)

    def tap(self, selector):
        x, y = self.center(selector)
        self.send("Input.dispatchTouchEvent", type="touchStart", touchPoints=[{"x": x, "y": y}])
        self.send("Input.dispatchTouchEvent", type="touchEnd", touchPoints=[])
        time.sleep(0.08)

    def key(self, key, code=None, vk=0, text=None, shift=False):
        base = {"key": key, "code": code or key, "windowsVirtualKeyCode": vk,
                "modifiers": 8 if shift else 0}
        down = dict(base, type="keyDown" if text else "rawKeyDown")
        if text:
            down["text"] = text
        self.send("Input.dispatchKeyEvent", **down)
        self.send("Input.dispatchKeyEvent", **dict(base, type="keyUp"))
        time.sleep(0.02)

    def screenshot(self, path):
        data = self.send("Page.captureScreenshot", format="png")["data"]
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))

    def close(self):
        try:
            self.send("Browser.close")
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)
        shutil.rmtree(self.downloads, ignore_errors=True)
