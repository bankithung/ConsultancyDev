"""
Encrypted document upload (multipart) and download (streamed, decrypted server-side).

Two things make documents unlike every other resource, and both are why these
tools are written by hand instead of generated.

The bytes never travel as JSON. An upload is multipart with a write-only `file`
part, and a download is a streamed attachment rather than a serialized record —
which is why the catalog marks the download action `skip_generated`. base64 is
the only way an MCP client can carry bytes over the protocol, so the translation
happens here, at the edge.

And a path on the machine running this server is not a path the caller can see.
`file_path` and `save_to` are refused unless the transport is stdio, where the
model, the server and the filesystem all belong to one person. Hosted over HTTP
the caller is remote and untrusted with this process's disk: honouring a path
there would let them read any file the server can read, and write anywhere it
can write. Nothing outside the named path is ever touched — a missing parent
directory is an error, not something to create, and a file that is already
there is an error unless the caller passed overwrite=true.
"""

from __future__ import annotations

import base64
import binascii
import mimetypes
import os
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..server import ServerState, client_for, run_api

# Appended to every refusal of a local path, so the caller learns the rule
# rather than just this one refusal.
HOSTED_NOTE = ('This server is reachable over HTTP, so its filesystem is not yours: local paths are '
               'accepted only when it runs locally over stdio.')


def _extension(file_name: str) -> str:
    return os.path.splitext(file_name)[1].lstrip('.').lower()


def _decode(file_base64: str) -> bytes:
    # Line breaks are dropped first because plenty of encoders wrap at 76
    # columns and that is not corruption. Everything else is validated:
    # without validate=True b64decode SILENTLY discards any character outside
    # the alphabet, so a truncated or double-encoded payload would upload as a
    # corrupt file and only fail much later, when someone opens the scan.
    try:
        return base64.b64decode(''.join(file_base64.split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ToolError(f'file_base64 is not valid base64 ({exc}). Send the file\'s raw bytes as '
                        'standard base64, padded.') from exc


def _read_local(file_path: str, stdio: bool) -> bytes:
    if not stdio:
        raise ToolError(f'file_path is not available here. {HOSTED_NOTE} Send the bytes as file_base64.')
    path = Path(os.path.expanduser(file_path)).resolve()
    if path.is_dir():
        raise ToolError(f'file_path {file_path} is a directory; name the file to upload.')
    if not path.is_file():
        raise ToolError(f'file_path {file_path} does not exist on the machine running this server.')
    try:
        return path.read_bytes()
    except OSError as exc:
        raise ToolError(f'Could not read {file_path}: {exc}') from exc


def _local_target(save_to: str, stdio: bool, overwrite: bool) -> Path:
    """
    The path save_to names, or a ToolError explaining why it cannot be written.

    Judged BEFORE the download runs. A refusal then costs no bytes, and the
    hosted caller is told the filesystem rule rather than whatever the fetch
    would have answered first.

    An existing file is refused unless the caller asked for it in the same
    call. download_document keeps readOnlyHint — nothing on the server changes,
    and saving the file locally is what the argument is for — so a client will
    not stop to confirm it, and a silent replace would be the tool quietly
    destroying a file nobody named twice.
    """
    if not stdio:
        raise ToolError(f'save_to is not available here. {HOSTED_NOTE} '
                        'Call again without save_to and the file comes back as base64.')
    target = Path(os.path.expanduser(save_to)).resolve()
    if target.is_dir():
        raise ToolError(f'save_to {save_to} is a directory; name the file to write.')
    if not target.parent.is_dir():
        raise ToolError(f'save_to {save_to}: the directory {target.parent} does not exist. Only the file '
                        'you name is written — no directories are created — so create it first.')
    if target.exists() and not overwrite:
        raise ToolError(f'save_to {save_to} already exists and nothing was written. Call again with '
                        'overwrite=true to replace it, or name a path that does not exist.')
    return target


def _write_local(target: Path, save_to: str, content: bytes) -> Path:
    try:
        target.write_bytes(content)
    except OSError as exc:
        raise ToolError(f'Could not write {save_to}: {exc}') from exc
    return target


def _file_name_from(disposition: str, document_id: int) -> str:
    """
    The attachment name the view sent, or a stand-in.

    Django writes `filename="scan.pdf"` when the name is ASCII and the RFC 5987
    `filename*=utf-8''...` form when it is not, and a student's name reaches the
    second branch often enough to matter, so both are read.
    """
    if "filename*=utf-8''" in disposition:
        return unquote(disposition.split("filename*=utf-8''")[-1].split(';')[0].strip('"; '))
    if 'filename=' in disposition:
        return disposition.split('filename=')[-1].split(';')[0].strip('"; ')
    return f'document-{document_id}'


def register_document_tools(mcp: FastMCP, state: ServerState) -> None:
    settings = state.settings
    uploads = state.catalog.conventions['uploads']
    allowed: list[str] = list(uploads['allowed_extensions'])
    max_upload: int = int(uploads['max_bytes'])
    allowed_text = ', '.join(allowed)

    def upload_document(ctx: Context, file_name: str, file_base64: str | None = None,
                        file_path: str | None = None, type: str = 'Other',
                        registration: int | None = None, enquiry: int | None = None,
                        expiry_date: str | None = None, status: str = 'IN') -> dict[str, Any]:
        """Upload a scan as an encrypted Document (POST /api/documents/, multipart). Give the content as file_base64, or as file_path when this server runs locally over stdio. Link it to at most ONE of registration / enquiry — never both — and student_name is derived from that link. `type` is a free label such as Passport, Offer Letter or Marksheet; `status` is IN or OUT (custody of the physical scan); `expiry_date` is YYYY-MM-DD. The file is encrypted at rest and can only be read back with download_document."""
        if registration and enquiry:
            raise ToolError('A document links to exactly one of registration or enquiry, never both. '
                            'student_name is derived from whichever you name.')
        # The extension is checked here as well as by the API, and BEFORE the
        # bytes are gathered: it is the one refusal worth knowing before
        # megabytes cross the wire, and the server's 400 does not list what it
        # would have accepted.
        extension = _extension(file_name)
        if extension not in allowed:
            raise ToolError(f'"{extension or "unknown"}" files are not accepted. file_name must end in one '
                            f'of: {allowed_text}.')
        if file_base64 and file_path:
            # Silently preferring one would upload bytes the caller did not
            # expect: the two arguments can disagree, and nothing downstream
            # could tell which file was meant.
            raise ToolError('Provide the content once: file_base64 or file_path, not both.')
        if file_base64:
            content = _decode(file_base64)
        elif file_path:
            content = _read_local(file_path, settings.stdio)
        else:
            raise ToolError('Provide the content as file_base64 (or, when this server runs locally over '
                            'stdio, as file_path).')
        if len(content) > max_upload:
            raise ToolError(f'The file is {len(content)} bytes; the server accepts at most {max_upload}.')

        data: dict[str, str] = {'file_name': file_name, 'type': type, 'status': status}
        if registration:
            data['registration'] = str(registration)
        if enquiry:
            data['enquiry'] = str(enquiry)
        if expiry_date:
            data['expiry_date'] = expiry_date
        content_type = mimetypes.guess_type(file_name)[0] or 'application/octet-stream'
        client = client_for(ctx, state)
        return run_api(lambda: client.post('documents/', data=data,
                                           files={'file': (file_name, content, content_type)}))

    def download_document(ctx: Context, id: int, save_to: str | None = None,
                          overwrite: bool = False) -> dict[str, Any]:
        """Download the decrypted file for a Document (GET /api/documents/{id}/download/). Returns {id, file_name, content_type, size} plus base64, or saved_to, or a note. With save_to — available only when this server runs locally over stdio — this tool writes a local file: the bytes go to that exact path (which must not be a directory, and whose directory must already exist) and none are returned. An existing file is refused, not replaced, unless you also pass overwrite=true. A 404 means the document is missing, outside your scope, or has no stored file."""
        # The target is settled before the fetch: see _local_target.
        target = _local_target(save_to, settings.stdio, overwrite) if save_to else None
        client = client_for(ctx, state)
        response = run_api(lambda: client.raw_get(f'documents/{id}/download/'))
        content = response.content
        # Response.headers is lowercase-keyed by every transport.
        meta: dict[str, Any] = {
            'id': id,
            'file_name': _file_name_from(response.headers.get('content-disposition', ''), id),
            'content_type': response.headers.get('content-type', 'application/octet-stream'),
            'size': len(content),
        }
        if target is not None:
            meta['saved_to'] = str(_write_local(target, save_to, content))
            return meta
        if len(content) <= settings.max_download_bytes:
            meta['base64'] = base64.b64encode(content).decode('ascii')
        else:
            # Metadata rather than a refusal: the caller still learns the name,
            # type and size, and can decide what to do about the bytes.
            meta['base64'] = None
            meta['note'] = (f'The file is {len(content)} bytes, above this server\'s '
                            f'{settings.max_download_bytes}-byte reply cap, so no bytes are returned. '
                            'Use save_to when the server runs locally over stdio, or raise '
                            'CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES.')
        return meta

    # The limits are appended rather than written into the docstrings: both
    # come from the running server (the catalog's upload rules, this process's
    # reply cap), so a client reads the real numbers instead of a guess.
    upload_description = ((upload_document.__doc__ or '').strip()
                          + f' Allowed extensions: {allowed_text}. Maximum {max_upload} bytes.')
    download_description = ((download_document.__doc__ or '').strip()
                            + f' Without save_to the content comes back as base64 when it is at most '
                              f'{settings.max_download_bytes} bytes; above that, base64 is null and a note '
                              f'explains how to get the file.')

    if not settings.read_only:
        # A write, but not destructive and not idempotent: two calls with the
        # same arguments create two documents.
        mcp.add_tool(upload_document, name='upload_document', description=upload_description,
                     structured_output=True,
                     annotations=ToolAnnotations(title='Upload document', readOnlyHint=False,
                                                 destructiveHint=False, idempotentHint=False))
    mcp.add_tool(download_document, name='download_document', description=download_description,
                 structured_output=True,
                 annotations=ToolAnnotations(title='Download document', readOnlyHint=True))
