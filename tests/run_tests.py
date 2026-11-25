"""Run the logic tests (tests.html) in a headless browser.

    python tests/run_tests.py
"""
import pathlib
import sys

from cdp import Browser

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main():
    browser = Browser()
    try:
        browser.goto((ROOT / "tests" / "tests.html").as_uri())
        browser.wait("!!window.testResults", timeout=120)
        results = browser.js("window.testResults")
        failed = {f["name"]: f["error"] for f in results["failed"]}
        for name in results["names"]:
            print(("FAIL " if name in failed else "pass ") + name)
            if name in failed:
                print("     " + failed[name])
        print(f"\n{results['total'] - len(failed)} of {results['total']} passed")
        if browser.errors:
            print("Browser errors:", browser.errors[:10])
        return 1 if failed or browser.errors else 0
    finally:
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
