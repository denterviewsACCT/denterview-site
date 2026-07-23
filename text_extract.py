"""
Pull plain-text paragraphs out of a submitted personal statement, whether
it arrived as a .docx or a .pdf. Empty paragraphs (blank lines) are dropped.
"""

import io
import re

from docx import Document
from pypdf import PdfReader

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_MIME = "application/pdf"


def extract_paragraphs_from_docx(docx_bytes: bytes) -> list[str]:
    doc = Document(io.BytesIO(docx_bytes))
    paragraphs = []
    for p in doc.paragraphs:
        text = p.text.strip()
        if text:
            paragraphs.append(text)
    return paragraphs


def extract_paragraphs_from_pdf(pdf_bytes: bytes) -> list[str]:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    full_text = "\n".join(page.extract_text() or "" for page in reader.pages)

    # Most PS PDFs (exported from Word/Docs) keep a blank line between
    # paragraphs -- split on that first.
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", full_text) if p.strip()]

    # Some PDF exports collapse paragraph breaks entirely, leaving one
    # giant blob with only line-wrap newlines. If splitting on blank lines
    # didn't actually separate anything, fall back to one paragraph per
    # non-empty line rather than silently sending Claude/the docx builder
    # one massive undifferentiated paragraph.
    if len(paragraphs) <= 1:
        paragraphs = [line.strip() for line in full_text.splitlines() if line.strip()]

    return paragraphs


def extract_paragraphs(content_bytes: bytes, mime_type: str = DOCX_MIME) -> list[str]:
    """Dispatch to the right extractor based on the (effective) mime type."""
    if mime_type == PDF_MIME:
        return extract_paragraphs_from_pdf(content_bytes)
    return extract_paragraphs_from_docx(content_bytes)


def parse_student_name(filename: str) -> tuple[str, str]:
    """
    Best-effort parse of 'FirstName_LastName' or 'FirstName Lastname - PS...'
    out of an intake filename. Falls back to ('Student', 'Unknown') so the
    pipeline never crashes on a weird filename -- worth checking those by hand.
    """
    stem = re.sub(r"\.(docx|pdf|doc)$", "", filename, flags=re.IGNORECASE)
    stem = re.split(r"[-_]?\s*(PS|Personal Statement)\b", stem, flags=re.IGNORECASE)[0]
    stem = stem.replace("_", " ").strip(" -_")
    parts = stem.split()
    if len(parts) >= 2:
        return parts[0], " ".join(parts[1:])
    if len(parts) == 1:
        return parts[0], "Unknown"
    return "Student", "Unknown"
