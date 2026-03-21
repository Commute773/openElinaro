#!/usr/bin/env python3

import asyncio
import json
import re
import sys
from pathlib import Path


def collapse_text(value: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", value)).strip()


def truncate(value: str, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars].rstrip() + "\n\n[truncated]", True


def strip_markdown(markdown: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " ", markdown)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"(^|\n)\s{0,3}#{1,6}\s*", r"\1", text)
    text = re.sub(r"(^|\n)\s*[-*+]\s+", r"\1", text)
    return collapse_text(text)


def coerce_markdown(markdown_value) -> str:
    if isinstance(markdown_value, str):
        return markdown_value.strip()

    for key in ("fit_markdown", "raw_markdown", "markdown_with_citations"):
        candidate = getattr(markdown_value, key, None)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()

    return ""


async def run(payload: dict) -> dict:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    artifact_dir = Path(payload["artifactDir"]).resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)

    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        page_timeout=int(payload.get("timeoutMs", 30000)),
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=payload["url"], config=run_config)

    if not getattr(result, "success", False):
        raise RuntimeError(getattr(result, "error_message", None) or "Crawl4AI crawl failed.")

    format_name = payload.get("format", "markdown")
    markdown = coerce_markdown(getattr(result, "markdown", ""))
    cleaned_html = getattr(result, "cleaned_html", None) or getattr(result, "html", "") or ""
    title = getattr(result, "title", None) or None
    final_url = getattr(result, "url", None) or payload["url"]
    content_type = "text/markdown" if markdown else "text/html"

    if format_name == "html":
        content, truncated = truncate(cleaned_html, int(payload.get("maxChars", 12000)))
        content_type = "text/html"
    elif format_name == "text":
        source = markdown or cleaned_html
        content, truncated = truncate(strip_markdown(source), int(payload.get("maxChars", 12000)))
        content_type = "text/plain"
    else:
        source = markdown or cleaned_html
        content, truncated = truncate(source, int(payload.get("maxChars", 12000)))
        content_type = "text/markdown" if markdown else "text/html"

    artifact_path = artifact_dir / "fetch.json"
    artifact_path.write_text(
        json.dumps(
            {
                "title": title,
                "url": final_url,
                "contentType": content_type,
                "format": format_name,
                "truncated": truncated,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    return {
        "url": payload["url"],
        "finalUrl": final_url,
        "format": format_name,
        "contentType": content_type,
        "title": title,
        "content": content,
        "truncated": truncated,
        "backend": "crawl4ai",
        "artifactDir": str(artifact_dir),
    }


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
        result = asyncio.run(run(payload))
        sys.stdout.write(json.dumps(result))
        return 0
    except Exception as error:
        sys.stderr.write(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
