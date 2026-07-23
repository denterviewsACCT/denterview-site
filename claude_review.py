"""
Calls Claude with the Denterview review prompt and asks for a structured
JSON review instead of free-text -- that's what makes the output mechanically
assemble-able into a docx with real Word comments and tracked changes.
"""

import json
from pathlib import Path

import anthropic

import config

PROMPT_PATH = Path(__file__).parent / "review_prompt.md"
MASTER_PROMPT = PROMPT_PATH.read_text()

# Strip the "how to use this prompt" header and the trailing placeholder --
# we only want the actual instructions, since we're calling the API directly
# rather than pasting into chat.
_START_MARKER = "## THE PROMPT"
_END_MARKER = "### NOW REVIEW THIS PERSONAL STATEMENT:"
_start = MASTER_PROMPT.index(_START_MARKER)
_end = MASTER_PROMPT.index(_END_MARKER)
REVIEW_INSTRUCTIONS = MASTER_PROMPT[_start:_end].strip()

JSON_SCHEMA_INSTRUCTIONS = """
IMPORTANT -- output format:

You must respond with ONLY a JSON object, no preamble, no markdown fences,
nothing before or after it. It must match this shape exactly:

{
  "intro": "the red bold intro paragraph, 4-6 sentences, as one string",
  "comments": [
    {
      "anchor": "the EXACT substring from the student's statement this comment is pinned to, copied verbatim, character for character, including punctuation",
      "comment": "the comment text, in your normal Denterview voice",
      "tracked_change": {
        "old": "exact substring to delete, must be contained within or equal to the anchor",
        "new": "the replacement text"
      }
    }
  ],
  "closing": "the red bold closing paragraph, ending with the second-edits link and sign-off, as one string"
}

Rules for "anchor":
- It must be copied EXACTLY from the statement text below -- same spelling,
  same punctuation, same capitalization. It will be used for an exact
  substring search, so if it doesn't match character-for-character the
  comment will be silently dropped.
- Keep each anchor as short as possible while still being unique in the
  document -- ideally a single sentence, never a whole paragraph.
- Do not let two anchors overlap each other.

Rules for "tracked_change":
- Omit this field entirely (do not include the key) if the comment is
  purely observational and doesn't involve an actual text edit.
- When present, "old" must be an exact substring of "anchor" (or equal to
  it), and "new" is what it should become.

Be as thorough as the statement requires -- there is no fixed number of
comments. Follow the full review framework above for what to look for.
"""


def review_statement(statement_text: str) -> dict:
    # Long timeout + max_retries=1: with streaming, tokens arrive continuously
    # so we should never actually hit this timeout waiting on a big blocking
    # read. It's a safety net for a truly dead connection, not the normal
    # path. Capping retries at 1 (SDK default is 2) limits how many times a
    # single slow-but-legitimate request can be re-sent -- each retry after
    # Claude has already started/finished generating is a second paid call.
    client = anthropic.Anthropic(
        api_key=config.ANTHROPIC_API_KEY,
        timeout=600.0,
        max_retries=1,
    )

    system_prompt = REVIEW_INSTRUCTIONS + "\n\n" + JSON_SCHEMA_INSTRUCTIONS

    # Non-streaming client.messages.create() waits for Claude to fully
    # finish generating (can be a couple minutes for a thorough review with
    # max_tokens=16000) before sending anything back. If our client-side
    # read times out during that wait, Claude has *already finished and
    # been billed for* the generation -- we just failed to receive it, and
    # the caller would have to pay for the whole thing again on retry.
    # Streaming avoids this: we receive tokens as they're produced, so we
    # never sit on one long blocking read.
    with client.messages.stream(
        model=config.CLAUDE_MODEL,
        max_tokens=16000,
        system=system_prompt,
        messages=[
            {
                "role": "user",
                "content": f"Here is the personal statement to review:\n\n{statement_text}",
            }
        ],
    ) as stream:
        for _ in stream.text_stream:
            pass  # we just want the accumulated final message below
        message = stream.get_final_message()

    if message.stop_reason == "max_tokens":
        raise RuntimeError(
            "Claude's response was cut off before finishing (hit the max_tokens "
            "limit). Try raising max_tokens further in claude_review.py."
        )

    raw = "".join(block.text for block in message.content if block.type == "text")
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        # Log enough of the raw output to debug in Railway logs without
        # flooding them if something goes very wrong.
        import logging
        logging.getLogger("ps-review").error(
            "Claude returned invalid JSON (%s). First 2000 chars:\n%s", e, raw[:2000]
        )
        raise
