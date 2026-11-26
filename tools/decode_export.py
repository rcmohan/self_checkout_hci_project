"""Turn survey responses back into readable session JSON.

    python tools/decode_export.py response.txt [more files]
    python tools/decode_export.py -o decoded response1.txt response2.txt

Each input file holds one response: the compressed text a participant pasted, or
a plain session JSON. Writes <name>.decoded.json beside the input, or into -o.
"""
import argparse
import base64
import gzip
import io
import json
import pathlib
import sys
import zlib

# Responses are untrusted input, so cap the decompressed size.
LIMIT = 20 * 1024 * 1024


def decode(text):
    """Return the session document in `text`, or raise ValueError."""
    try:
        # strict=False tolerates line breaks that a survey tool may have inserted.
        doc = json.loads(text.strip().lstrip("﻿"), strict=False)
        if isinstance(doc, dict) and doc.get("encoding") == "gzip+base64":
            raw = base64.b64decode("".join(doc["data"].split()), validate=True)
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                body = stream.read(LIMIT + 1)
            if len(body) > LIMIT:
                raise ValueError("decoded data is too large")
            doc = json.loads(body.decode("utf-8"))
    except (ValueError, OSError, EOFError, zlib.error, KeyError, TypeError, AttributeError) as error:
        raise ValueError(f"could not decode (truncated or altered?): {error}") from error
    if not isinstance(doc, dict) or "sessionId" not in doc or "events" not in doc:
        raise ValueError("not a session export")
    return doc


def main(argv=None):
    parser = argparse.ArgumentParser(description="Decode self-checkout session responses.")
    parser.add_argument("files", nargs="+", type=pathlib.Path)
    parser.add_argument("-o", "--output-dir", type=pathlib.Path)
    args = parser.parse_args(argv)
    failures = 0
    written = set()
    for path in args.files:
        try:
            doc = decode(path.read_text(encoding="utf-8-sig"))
            folder = args.output_dir or path.parent
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / (path.stem + ".decoded.json")
            if target in written:
                raise ValueError(f"another input already produced {target.name}; rename one")
            target.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
            written.add(target)
            print(f"{path} -> {target}  (session {doc['sessionId']}, {len(doc['events'])} events)")
        except (OSError, ValueError) as error:
            failures += 1
            print(f"{path}: {error}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
