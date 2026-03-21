#!/usr/bin/env python3

import asyncio
import base64
import json
import sys
from pathlib import Path


class BrowserSession:
    def __init__(self) -> None:
        self.browser = None
        self.config = None

    async def get_page(self, payload: dict, reset_session: bool = False):
        next_config = {
            "headless": bool(payload.get("headless", True)),
            "userDataDir": payload.get("userDataDir"),
        }
        reused_session = (
            self.browser is not None
            and not reset_session
            and self.config == next_config
        )

        if reset_session or (self.browser is not None and self.config != next_config):
            await self.stop()

        if self.browser is None:
            from openbrowser import Browser

            self.browser = Browser(
                headless=next_config["headless"],
                user_data_dir=next_config["userDataDir"],
            )
            await self.browser.start()
            self.config = next_config

        page = await self.browser.get_current_page() or await self.browser.new_page()
        return page, reused_session

    async def stop(self):
        if self.browser is None:
            return

        try:
            await self.browser.stop()
        finally:
            self.browser = None
            self.config = None


async def run_payload(session: BrowserSession, payload: dict, reset_session: bool = False) -> dict:
    artifact_dir = Path(payload["artifactDir"]).resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)

    page, reused_session = await session.get_page(payload, reset_session=reset_session)
    screenshots: list[dict[str, str]] = []
    step_results: list[dict] = []

    viewport = payload.get("viewport")
    if viewport:
        await page.set_viewport_size(int(viewport["width"]), int(viewport["height"]))

    start_url = payload.get("startUrl")
    if start_url:
        await page.goto(start_url)
        await asyncio.sleep(1)

    async def save_screenshot(
        step_index: int,
        action_type: str,
        *,
        requested_path=None,
        screenshot_format: str = "png",
        quality=None,
    ) -> Path:
        screenshot_b64 = await page.screenshot(
            format=screenshot_format,
            quality=quality,
        )
        output_path = (
            artifact_dir / requested_path
            if requested_path
            else artifact_dir / "screenshots" / f"step-{step_index + 1:02d}-{action_type}.{screenshot_format}"
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(base64.b64decode(screenshot_b64))
        screenshots.append(
            {
                "path": str(output_path),
                "format": screenshot_format,
            }
        )
        return output_path

    async def insert_text(text: str, delay_ms: int = 0):
        session_id = await page._ensure_session()
        for char in text:
            await page._client.send.Input.insertText({"text": char}, session_id=session_id)
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000)

    async def build_action_error(
        error: Exception,
        *,
        step_index: int,
        action_type: str,
    ) -> dict:
        screenshot_path = None
        try:
            screenshot_path = await save_screenshot(step_index, action_type)
        except Exception:
            screenshot_path = None

        page_title = None
        page_url = None
        try:
            page_title = await page.get_title()
        except Exception:
            page_title = None
        try:
            page_url = await page.get_url()
        except Exception:
            page_url = None

        details = {
            "message": f"OpenBrowser action failed during {action_type} at step {step_index + 1}: {error}",
            "category": "action_error",
            "actionIndex": step_index,
            "actionType": action_type,
            "artifactDir": str(artifact_dir),
            "pageTitle": page_title,
            "pageUrl": page_url,
            "exception": str(error),
        }
        if screenshot_path is not None:
            details["screenshotPath"] = str(screenshot_path)
            details["screenshotFormat"] = "png"
        return details

    actions = payload.get("actions", [])
    for index, action in enumerate(actions):
        action_type = action["type"]
        detail = None
        value = None
        output_path = None

        try:
            if action_type == "navigate":
                await page.goto(action["url"])
                await asyncio.sleep(action.get("waitMs", 1000) / 1000)
                detail = f'navigated to {action["url"]}'
            elif action_type == "wait":
                await asyncio.sleep(action["ms"] / 1000)
                detail = f'waited {action["ms"]}ms'
            elif action_type == "mouse_move":
                mouse = await page.mouse
                await mouse.move(int(action["x"]), int(action["y"]), int(action.get("steps", 1)))
                detail = f'moved mouse to ({action["x"]}, {action["y"]})'
            elif action_type == "mouse_click":
                mouse = await page.mouse
                await mouse.click(
                    int(action["x"]),
                    int(action["y"]),
                    action.get("button", "left"),
                    int(action.get("clickCount", 1)),
                )
                detail = f'clicked at ({action["x"]}, {action["y"]})'
            elif action_type == "press":
                await page.press(action["key"])
                detail = f'pressed {action["key"]}'
            elif action_type == "type":
                await insert_text(str(action["text"]), int(action.get("delayMs", 0)))
                if action.get("submit"):
                    await page.press("Enter")
                detail = f"typed {len(str(action['text']))} characters"
                if action.get("submit"):
                    detail = f"{detail} and submitted"
            elif action_type == "evaluate":
                value = await page.evaluate(action["expression"], *(action.get("args") or []))
                if not action.get("captureResult", True):
                    value = None
                detail = "evaluated JavaScript"
            elif action_type == "screenshot":
                output_path = await save_screenshot(
                    index,
                    action_type,
                    requested_path=action.get("path"),
                    screenshot_format=action.get("format", "png"),
                    quality=action.get("quality"),
                )
                detail = f"saved screenshot to {output_path}"
            else:
                raise ValueError(f"Unsupported OpenBrowser action type: {action_type}")
        except Exception as error:
            return {
                "ok": False,
                "error": await build_action_error(error, step_index=index, action_type=action_type),
            }

        if output_path is None:
            output_path = await save_screenshot(index, action_type)
            detail = f"{detail}; state saved to {output_path}" if detail else f"saved state to {output_path}"

        step_result = {
            "index": index,
            "type": action_type,
            "status": "ok",
        }
        if detail is not None:
            step_result["detail"] = detail
        if value is not None:
            step_result["value"] = value
        if output_path is not None:
            step_result["path"] = str(output_path)
        step_results.append(step_result)

    return {
        "ok": True,
        "sessionId": getattr(session.browser, "id", "openbrowser-session"),
        "reusedSession": reused_session,
        "title": await page.get_title(),
        "finalUrl": await page.get_url(),
        "artifactDir": str(artifact_dir),
        "screenshots": screenshots,
        "stepResults": step_results,
    }


async def process_stream() -> int:
    session = BrowserSession()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break

            stripped = line.strip()
            if not stripped:
                continue

            message = json.loads(stripped)
            if isinstance(message, dict) and "commandId" in message and "payload" in message:
                command_id = message["commandId"]
                try:
                    result = await run_payload(
                        session,
                        message["payload"],
                        reset_session=bool(message.get("resetSession", False)),
                    )
                    if result.get("ok") is False:
                        sys.stdout.write(
                            json.dumps(
                                {
                                    "commandId": command_id,
                                    "ok": False,
                                    "error": result["error"],
                                }
                            )
                            + "\n"
                        )
                    else:
                        sys.stdout.write(
                            json.dumps(
                                {
                                    "commandId": command_id,
                                    "ok": True,
                                    "result": result,
                                }
                            )
                            + "\n"
                        )
                    sys.stdout.flush()
                except Exception as error:
                    sys.stdout.write(
                        json.dumps(
                            {
                                "commandId": command_id,
                                "ok": False,
                                "error": {
                                    "message": str(error),
                                    "category": "runner_error",
                                },
                            }
                        )
                        + "\n"
                    )
                    sys.stdout.flush()
                continue

            try:
                result = await run_payload(session, message, reset_session=False)
            except Exception as error:
                result = {
                    "ok": False,
                    "error": {
                        "message": str(error),
                        "category": "runner_error",
                    },
                }
            sys.stdout.write(json.dumps(result))
            sys.stdout.flush()
            return 0

        return 0
    finally:
        await session.stop()


def main() -> int:
    try:
        return asyncio.run(process_stream())
    except Exception as error:
        sys.stderr.write(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
