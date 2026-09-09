from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


BASE_URL = os.environ.get("FEY_DOCS_URL", "http://127.0.0.1:4173")
ARTIFACT_DIR = Path(
    os.environ.get(
        "FEY_DOCS_ARTIFACT_DIR",
        str(Path(__file__).resolve().parent / "artifacts"),
    )
)

PAGES = [
    "index.html",
    "getting-started.html",
    "create.html",
    "anchors.html",
    "diagrams.html",
    "drift.html",
    "improve.html",
    "hooks.html",
    "reference.html",
    "principles.html",
]


def assert_no_overflow(page: Page, label: str) -> None:
    overflow = page.evaluate(
        """() => ({
          width: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth
        })"""
    )
    assert overflow["width"] <= overflow["viewport"] + 1, (
        f"{label}: horizontal overflow {overflow['width']} > {overflow['viewport']}"
    )


def load(page: Page, name: str) -> None:
    response = page.goto(f"{BASE_URL}/{name}", wait_until="networkidle")
    assert response is not None and response.ok, f"{name}: failed to load"
    page.locator("h1").wait_for(state="visible")


def main() -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        desktop = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = desktop.new_page()
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(str(error)))

        for name in PAGES:
            load(page, name)
            assert page.locator(".site-header").is_visible(), f"{name}: header hidden"
            assert_no_overflow(page, f"desktop {name}")

        load(page, "index.html")
        skip_box = page.locator(".skip-link").bounding_box()
        assert skip_box is not None and skip_box["y"] + skip_box["height"] <= 0
        assert page.locator("[data-fey-node]").count() == 4
        initial_capability = page.locator("[data-feynman-stage]").get_attribute("data-active")
        page.wait_for_timeout(2100)
        assert page.locator("[data-feynman-stage]").get_attribute("data-active") != initial_capability
        page.locator('[data-fey-node="optimize"]').hover()
        page.wait_for_timeout(100)
        assert page.locator("[data-feynman-stage]").get_attribute("data-active") == "optimize"
        assert page.locator('[data-fey-edge="optimize"]').is_visible()
        page.locator('[data-fey-node="wiki"]').focus()
        assert page.locator("[data-feynman-stage]").get_attribute("data-active") == "wiki"
        page.locator('[data-view-tab="diagrams"]').click()
        assert page.locator('[data-view-panel="diagrams"]').is_visible()
        page.screenshot(path=str(ARTIFACT_DIR / "home-desktop.png"), full_page=True)

        page.set_viewport_size({"width": 2000, "height": 1150})
        load(page, "index.html")
        hero_copy = page.locator(".hero-copy").bounding_box()
        hero_map = page.locator(".feynman-stage").bounding_box()
        assert hero_copy is not None and hero_map is not None
        assert hero_map["x"] >= hero_copy["x"] + hero_copy["width"] + 40
        assert page.locator(".hero-copy h1").evaluate(
            "(element) => element.scrollWidth <= element.clientWidth + 1"
        )
        assert page.locator(".feynman-stage").evaluate(
            "(element) => getComputedStyle(element).borderTopWidth"
        ) == "0px"
        assert page.locator(".feynman-core-label img").is_visible()
        page.locator(".hero").screenshot(path=str(ARTIFACT_DIR / "hero-wide.png"))

        page.set_viewport_size({"width": 1000, "height": 900})
        load(page, "index.html")
        hero_copy = page.locator(".hero-copy").bounding_box()
        hero_map = page.locator(".feynman-stage").bounding_box()
        assert hero_copy is not None and hero_map is not None
        assert hero_map["y"] > hero_copy["y"]
        assert_no_overflow(page, "tablet index.html")
        page.set_viewport_size({"width": 1440, "height": 1000})

        load(page, "improve.html")
        assert page.locator(".docs-sidebar").is_visible()
        assert page.locator(".docs-toc a").count() >= 5
        page.screenshot(path=str(ARTIFACT_DIR / "improve-desktop.png"), full_page=True)
        desktop.close()

        mobile = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = mobile.new_page()
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(str(error)))

        for name in PAGES:
            load(page, name)
            assert_no_overflow(page, f"mobile {name}")

        load(page, "index.html")
        page.locator(".nav-toggle").click()
        page.wait_for_timeout(300)
        assert "is-open" in (page.locator(".mobile-nav").get_attribute("class") or "")
        assert page.locator(".mobile-nav").is_visible()
        page.set_viewport_size({"width": 1200, "height": 844})
        page.wait_for_timeout(100)
        assert "nav-open" not in (page.locator("body").get_attribute("class") or "")
        assert page.evaluate("getComputedStyle(document.body).overflow") != "hidden"
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert page.locator(".feynman-map").evaluate("(element) => getComputedStyle(element).display") == "none"
        assert page.locator("[data-fey-node]").count() == 4
        page.screenshot(path=str(ARTIFACT_DIR / "home-mobile.png"), full_page=True)

        load(page, "getting-started.html")
        menu_button = page.locator("[data-mobile-doc-controls] [data-doc-menu]")
        menu_button.click()
        page.wait_for_timeout(300)
        assert page.locator(".docs-sidebar").is_visible()
        assert page.locator("[data-doc-close]").evaluate("(element) => element === document.activeElement")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        assert "is-open" not in (page.locator(".docs-sidebar").get_attribute("class") or "")
        assert menu_button.evaluate("(element) => element === document.activeElement")
        page.screenshot(path=str(ARTIFACT_DIR / "docs-mobile.png"), full_page=True)
        mobile.close()

        reduced = browser.new_context(
            viewport={"width": 1280, "height": 900},
            reduced_motion="reduce",
        )
        page = reduced.new_page()
        load(page, "index.html")
        assert page.locator(".feynman-pulses").evaluate("(element) => getComputedStyle(element).display") == "none"
        reduced.close()

        browser.close()

    if console_errors:
        raise SystemExit("Browser console errors:\n- " + "\n- ".join(console_errors))
    print(f"Validated {len(PAGES)} pages at desktop and mobile widths.")


if __name__ == "__main__":
    main()
