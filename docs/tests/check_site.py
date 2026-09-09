from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse


DOCS = Path(__file__).resolve().parents[1]


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.links: list[str] = []
        self.assets: list[str] = []
        self.h1_count = 0
        self.title_count = 0
        self.has_description = False
        self.images_without_alt: list[str] = []
        self.in_head = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "head":
            self.in_head = True
        if values.get("id"):
            self.ids.append(values["id"])
        if tag == "a" and values.get("href"):
            self.links.append(values["href"])
        if tag in {"script", "img"} and values.get("src"):
            self.assets.append(values["src"])
        if tag == "link" and values.get("href"):
            self.assets.append(values["href"])
        if tag == "h1":
            self.h1_count += 1
        if tag == "title" and self.in_head:
            self.title_count += 1
        if self.in_head and tag == "meta" and values.get("name") == "description" and values.get("content"):
            self.has_description = True
        if tag == "img" and "alt" not in values:
            self.images_without_alt.append(values.get("src", "<unknown>"))

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self.in_head = False


def local_target(page: Path, href: str) -> tuple[Path, str | None] | None:
    if href.startswith(("http://", "https://", "mailto:", "tel:", "data:", "javascript:")):
        return None
    parsed = urlparse(href)
    fragment = unquote(parsed.fragment) if parsed.fragment else None
    if parsed.path.startswith("/fey/"):
        relative = parsed.path.removeprefix("/fey/")
        target = DOCS / relative
    elif parsed.path.startswith("/"):
        return None
    elif parsed.path:
        target = (page.parent / unquote(parsed.path)).resolve()
    else:
        target = page
    if target.is_dir():
        target = target / "index.html"
    return target, fragment


def parse_pages() -> dict[Path, PageParser]:
    pages: dict[Path, PageParser] = {}
    for page in sorted(DOCS.glob("*.html")):
        parser = PageParser()
        parser.feed(page.read_text(encoding="utf-8"))
        pages[page.resolve()] = parser
    return pages


def main() -> None:
    pages = parse_pages()
    errors: list[str] = []

    for page, parser in pages.items():
        name = page.name
        duplicates = sorted({value for value in parser.ids if parser.ids.count(value) > 1})
        if duplicates:
            errors.append(f"{name}: duplicate ids: {', '.join(duplicates)}")
        if parser.h1_count != 1:
            errors.append(f"{name}: expected one h1, found {parser.h1_count}")
        if parser.title_count != 1:
            errors.append(f"{name}: expected one title, found {parser.title_count}")
        if name != "404.html" and not parser.has_description:
            errors.append(f"{name}: missing meta description")
        if parser.images_without_alt:
            errors.append(f"{name}: images without alt: {', '.join(parser.images_without_alt)}")

        for asset in parser.assets:
            target = local_target(page, asset)
            if not target:
                continue
            asset_path, _ = target
            if not asset_path.exists():
                errors.append(f"{name}: missing asset {asset}")

        for href in parser.links:
            target = local_target(page, href)
            if not target:
                continue
            target_path, fragment = target
            if not target_path.exists():
                errors.append(f"{name}: missing link target {href}")
                continue
            if fragment and target_path.suffix.lower() == ".html":
                target_parser = pages.get(target_path.resolve())
                if target_parser and fragment not in target_parser.ids:
                    errors.append(f"{name}: missing fragment target {href}")

    expected = {
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
        "404.html",
    }
    missing = sorted(expected - {page.name for page in pages})
    if missing:
        errors.append(f"missing expected pages: {', '.join(missing)}")

    if errors:
        raise SystemExit("Site validation failed:\n- " + "\n- ".join(errors))
    print(f"Validated {len(pages)} HTML pages, internal links, assets, headings, and metadata.")


if __name__ == "__main__":
    main()
