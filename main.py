"""
Entry point for the ps-review service.

GET/POST /poll?secret=...  -- kicks off a background pass over the intake
                              folder and returns immediately. The actual
                              review work (Claude call, docx build, Drive
                              upload) happens in a background thread so a
                              slow review never trips Railway's proxy
                              timeout waiting on the HTTP response.

/status?secret=...         -- shows the result of the most recent run,
                              once it finishes.

Meant to be hit on a schedule (Railway Cron, or an external cron pinging
the URL) rather than run as a constantly-looping worker -- simpler to
reason about and cheaper to run.
"""

import logging
import threading
import time
import traceback

from flask import Flask, jsonify, request

import config
import drive_client
from claude_review import review_statement
from docx_builder import build_reviewed_docx
from text_extract import extract_paragraphs, parse_student_name

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ps-review")

app = Flask(__name__)

_lock = threading.Lock()
_state = {"running": False, "last_result": None, "last_started": None}

# In-memory failure counter per intake file id. Resets on redeploy/restart,
# which is fine -- its job is just to stop a broken file from silently
# re-billing a Claude call on every single /poll (every ~10 min) forever.
# After MAX_CONSECUTIVE_FAILURES, we stop calling Claude for that file and
# surface it loudly in /status until someone looks at it.
MAX_CONSECUTIVE_FAILURES = 3
_failure_counts: dict[str, int] = {}


@app.route("/")
def health():
    return jsonify({"status": "ok"})


def _run_pipeline():
    results = {"processed": [], "skipped": [], "errors": []}
    try:
        intake_files = drive_client.list_folder(config.UPLOADS_FOLDER_ID)
    except Exception as e:
        log.exception("Failed to list intake folder")
        with _lock:
            _state["running"] = False
            _state["last_result"] = {"error": f"could not list intake folder: {e}"}
        return

    for f in intake_files:
        file_id = f["id"]
        filename = f["name"]
        mime_type = f["mimeType"]

        try:
            first, last = parse_student_name(filename)
            output_name = f"{first}_{last}_PS_TO_RETURN.docx"

            if drive_client.file_exists_in_folder(config.RETURNED_FOLDER_ID, output_name):
                results["skipped"].append(filename)
                _failure_counts.pop(file_id, None)
                continue

            if _failure_counts.get(file_id, 0) >= MAX_CONSECUTIVE_FAILURES:
                log.warning(
                    "Skipping %s -- failed %d times already, needs manual attention",
                    filename, _failure_counts[file_id],
                )
                results["errors"].append({
                    "file": filename,
                    "error": f"skipped after {_failure_counts[file_id]} consecutive failures "
                             f"-- check /status history and fix by hand before retrying",
                })
                continue

            log.info("Processing %s", filename)
            content_bytes, effective_mime = drive_client.download_source(file_id, mime_type)
            paragraphs = extract_paragraphs(content_bytes, effective_mime)

            if not paragraphs:
                results["errors"].append({"file": filename, "error": "no extractable text"})
                continue

            # Reuse a cached review if a prior run got Claude's response
            # back successfully but failed afterward (docx build / upload).
            # That avoids paying for another Claude call for work we've
            # already paid for once.
            review = drive_client.get_cached_review(config.RETURNED_FOLDER_ID, output_name)
            if review is not None:
                log.info("Using cached review for %s (skipping Claude call)", filename)
            else:
                statement_text = "\n".join(paragraphs)
                log.info("Calling Claude for %s", filename)
                review = review_statement(statement_text)
                log.info("Got review back for %s, caching before docx build", filename)
                drive_client.save_cached_review(config.RETURNED_FOLDER_ID, output_name, review)

            build_result = build_reviewed_docx(paragraphs, review)
            drive_client.upload_docx(config.RETURNED_FOLDER_ID, output_name, build_result.docx_bytes)
            drive_client.delete_cached_review(config.RETURNED_FOLDER_ID, output_name)
            log.info("Uploaded %s", output_name)
            _failure_counts.pop(file_id, None)

            entry = {"file": filename, "output": output_name}
            if build_result.unmatched:
                entry["unmatched_comments"] = [c.get("comment", "")[:120] for c in build_result.unmatched]
            results["processed"].append(entry)

        except Exception as e:
            log.exception("Failed processing %s", filename)
            _failure_counts[file_id] = _failure_counts.get(file_id, 0) + 1
            results["errors"].append({"file": filename, "error": str(e), "trace": traceback.format_exc()})

    with _lock:
        _state["running"] = False
        _state["last_result"] = results


@app.route("/poll", methods=["GET", "POST"])
def poll():
    if request.args.get("secret") != config.POLL_SECRET:
        return jsonify({"error": "unauthorized"}), 401

    with _lock:
        if _state["running"]:
            return jsonify({"status": "already running", "started": _state["last_started"]})
        _state["running"] = True
        _state["last_started"] = time.time()

    thread = threading.Thread(target=_run_pipeline, daemon=True)
    thread.start()

    return jsonify({"status": "started", "check": "/status?secret=... for results"})


@app.route("/status", methods=["GET"])
def status():
    if request.args.get("secret") != config.POLL_SECRET:
        return jsonify({"error": "unauthorized"}), 401
    with _lock:
        return jsonify(
            {
                "running": _state["running"],
                "last_started": _state["last_started"],
                "last_result": _state["last_result"],
            }
        )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)

