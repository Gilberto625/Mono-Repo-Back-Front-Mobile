"""Validación mínima de imágenes por extensión, MIME declarado y firma binaria."""

from pathlib import Path
from typing import Any

_ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _detected_image_type(header: bytes) -> str | None:
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def is_allowed_image_upload(file: Any) -> bool:
    extension = Path(str(getattr(file, "name", "") or "")).suffix.lower()
    declared_mime = str(getattr(file, "content_type", "") or "").strip().lower()
    if extension not in _ALLOWED_EXTENSIONS or declared_mime not in _ALLOWED_MIME_TYPES:
        return False

    position = None
    try:
        position = file.tell()
    except (AttributeError, OSError):
        pass
    try:
        header = file.read(16)
    except (AttributeError, OSError, TypeError):
        return False
    finally:
        try:
            file.seek(position if position is not None else 0)
        except (AttributeError, OSError):
            pass

    detected_mime = _detected_image_type(bytes(header or b""))
    if detected_mime != declared_mime:
        return False
    if detected_mime == "image/jpeg":
        return extension in {".jpg", ".jpeg"}
    return extension == {"image/png": ".png", "image/webp": ".webp"}.get(detected_mime)
