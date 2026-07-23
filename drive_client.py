"""
Thin wrapper around the Drive v3 API for the two folders we care about.
"""

import io
import json

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

import config

SCOPES = ["https://www.googleapis.com/auth/drive"]

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
JSON_MIME = "application/json"

# Cache filename convention: same stem as the eventual output docx, with a
# .review.json suffix, stored in the same RETURNED_FOLDER_ID. Lets us tell
# at a glance which review is cached for which student.
def _cache_filename(output_name: str) -> str:
    return output_name.replace(".docx", "") + ".review.json"


def _get_service():
    info = json.loads(config.GOOGLE_SERVICE_ACCOUNT_JSON)
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds)


def list_folder(folder_id: str) -> list[dict]:
    """List all non-trashed files directly inside a folder."""
    service = _get_service()
    files = []
    page_token = None
    query = f"'{folder_id}' in parents and trashed = false"
    while True:
        resp = service.files().list(
            q=query,
            fields="nextPageToken, files(id, name, mimeType, createdTime)",
            pageToken=page_token,
        ).execute()
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files


def file_exists_in_folder(folder_id: str, filename: str) -> bool:
    service = _get_service()
    safe_name = filename.replace("'", "\\'")
    query = f"'{folder_id}' in parents and trashed = false and name = '{safe_name}'"
    resp = service.files().list(q=query, fields="files(id)").execute()
    return len(resp.get("files", [])) > 0


PDF_MIME = "application/pdf"


def download_source(file_id: str, mime_type: str) -> tuple[bytes, str]:
    """
    Download a file's content, normalizing Google Docs to .docx via export.
    Returns (content_bytes, effective_mime_type) so the caller can pick the
    right text-extraction path (docx vs pdf) -- native PDFs are downloaded
    as-is rather than forced through the docx exporter, which would corrupt
    them.
    """
    service = _get_service()
    if mime_type == GOOGLE_DOC_MIME:
        request = service.files().export_media(fileId=file_id, mimeType=DOCX_MIME)
        effective_mime = DOCX_MIME
    else:
        request = service.files().get_media(fileId=file_id)
        effective_mime = mime_type

    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue(), effective_mime


def upload_docx(folder_id: str, filename: str, content_bytes: bytes) -> str:
    """Upload a .docx file to a folder. Returns the new file's ID."""
    service = _get_service()
    file_metadata = {"name": filename, "parents": [folder_id]}
    media = MediaIoBaseUpload(
        io.BytesIO(content_bytes),
        mimetype=DOCX_MIME,
        resumable=True,
    )
    result = service.files().create(
        body=file_metadata, media_body=media, fields="id"
    ).execute()
    return result["id"]


def get_cached_review(folder_id: str, output_name: str) -> dict | None:
    """
    Look for a previously-saved Claude review JSON for this student (saved
    right after a successful Claude call, before docx building/upload). If
    found, return the parsed dict so we can skip paying for Claude again.
    Returns None if no cache exists yet.
    """
    service = _get_service()
    cache_name = _cache_filename(output_name)
    safe_name = cache_name.replace("'", "\\'")
    query = f"'{folder_id}' in parents and trashed = false and name = '{safe_name}'"
    resp = service.files().list(q=query, fields="files(id)").execute()
    matches = resp.get("files", [])
    if not matches:
        return None

    file_id = matches[0]["id"]
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, service.files().get_media(fileId=file_id))
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return json.loads(buf.getvalue().decode("utf-8"))


def save_cached_review(folder_id: str, output_name: str, review: dict) -> None:
    """Save Claude's raw review JSON immediately after a successful call."""
    service = _get_service()
    cache_name = _cache_filename(output_name)
    content = json.dumps(review).encode("utf-8")
    media = MediaIoBaseUpload(io.BytesIO(content), mimetype=JSON_MIME, resumable=False)
    service.files().create(
        body={"name": cache_name, "parents": [folder_id]},
        media_body=media,
        fields="id",
    ).execute()


def delete_cached_review(folder_id: str, output_name: str) -> None:
    """Clean up the cache file once the final docx has uploaded successfully."""
    service = _get_service()
    cache_name = _cache_filename(output_name)
    safe_name = cache_name.replace("'", "\\'")
    query = f"'{folder_id}' in parents and trashed = false and name = '{safe_name}'"
    resp = service.files().list(q=query, fields="files(id)").execute()
    for f in resp.get("files", []):
        service.files().delete(fileId=f["id"]).execute()
