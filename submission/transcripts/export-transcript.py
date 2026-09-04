#!/usr/bin/env python3
"""
Turn a Claude Code session log (.jsonl) into a readable transcript.

Screenshots are replaced by a placeholder and long tool output is clipped --
both are marked where it happens, so the record stays honest about what was
left out. Nothing else is altered.
"""
import json, sys, datetime

TOOL_RESULT_LIMIT = 1200
TOOL_INPUT_LIMIT = 900


def clip(text, limit):
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [clipped, {len(text) - limit:,} more characters]"


def render_blocks(content):
    """A message's content is either a string or a list of typed blocks."""
    if isinstance(content, str):
        return [content.strip()] if content.strip() else []

    out = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")

        if kind == "text":
            if block.get("text", "").strip():
                out.append(block["text"].strip())

        elif kind == "thinking":
            pass  # internal reasoning, not part of the working record

        elif kind == "image":
            out.append("_[screenshot]_")

        elif kind == "tool_use":
            args = json.dumps(block.get("input", {}), ensure_ascii=False, indent=2)
            out.append(f"**→ {block.get('name', 'tool')}**\n```json\n{clip(args, TOOL_INPUT_LIMIT)}\n```")

        elif kind == "tool_result":
            body = block.get("content")
            if isinstance(body, list):
                parts = []
                for piece in body:
                    if isinstance(piece, dict) and piece.get("type") == "image":
                        parts.append("[screenshot]")
                    elif isinstance(piece, dict):
                        parts.append(str(piece.get("text", "")))
                    else:
                        parts.append(str(piece))
                body = "\n".join(parts)
            body = clip(body if body is not None else "", TOOL_RESULT_LIMIT)
            if body.strip():
                out.append(f"**← result**\n```\n{body}\n```")
    return out


def main(path, out_path, title):
    turns, first_ts, last_ts = [], None, None

    with open(path, errors="ignore") as handle:
        for line in handle:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") not in ("user", "assistant"):
                continue
            message = rec.get("message")
            if not isinstance(message, dict):
                continue

            blocks = render_blocks(message.get("content"))
            if not blocks:
                continue

            stamp = rec.get("timestamp")
            if stamp:
                first_ts = first_ts or stamp
                last_ts = stamp
            turns.append((message.get("role", "?"), stamp, blocks))

    def when(stamp):
        if not stamp:
            return "?"
        try:
            return datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M UTC")
        except ValueError:
            return stamp

    lines = [
        f"# {title}",
        "",
        f"Claude Code session `{path.split('/')[-1].replace('.jsonl', '')}`  ",
        f"{when(first_ts)} — {when(last_ts)} · {len(turns)} messages",
        "",
        "> Exported from the session log. Screenshots appear as `[screenshot]` and long",
        "> tool output is clipped, with the amount removed noted at the cut. Nothing else",
        "> has been edited.",
        "",
        "---",
        "",
    ]
    for role, stamp, blocks in turns:
        who = "User" if role == "user" else "Claude"
        lines.append(f"### {who} · {when(stamp)}")
        lines.append("")
        lines.extend(b + "\n" for b in blocks)
        lines.append("---")
        lines.append("")

    text = "\n".join(lines)
    with open(out_path, "w") as handle:
        handle.write(text)
    print(f"{out_path}  {len(text):,} bytes  ·  {len(turns)} messages")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
