"""Validación de subidas: HEIC/HEIF suelen llegar con MIME vacío o application/octet-stream."""

import re
from typing import Any

_IMAGE_EXT = re.compile(r"\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif)$", re.IGNORECASE)


def is_allowed_image_upload(file: Any) -> bool:
    ct = str(getattr(file, "content_type", None) or "").strip().lower()
    if ct.startswith("image/"):
        return True
    if ct in ("application/octet-stream", "binary/octet-stream", ""):
        name = str(getattr(file, "name", None) or "")
        return bool(_IMAGE_EXT.search(name))
    return False
