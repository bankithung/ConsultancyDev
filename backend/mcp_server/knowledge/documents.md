# Documents: uploaded scans versus physical originals

Two separate concepts share the word "document". Mixing them up is the usual way a client
answers the wrong question about a passport.

## Document (`documents/`): an uploaded scan

- Create with multipart/form-data: the write-only `file`, plus `file_name`, `type` (free text;
  the console uses values such as Passport, Aadhaar, Marksheet, Photo, Offer Letter, Visa,
  Other), `status` (IN or OUT — custody of the scan, default IN), `expiry_date` (a date or
  null), and **at most one of** `registration` or `enquiry`. `student_name` is derived from
  whichever link is set and any value a client sends is ignored. A metadata-only write may be
  plain JSON; only a file needs multipart.
- The server validates the extension (pdf, png, jpg, jpeg, webp, doc, docx, xls, xlsx by
  default) and the size (10 MB by default), stores a sha256 checksum, then encrypts the bytes
  with Fernet under PRIVATE_MEDIA_ROOT, which is never web-served. `file_size` is the plaintext
  length, so it will not match the size on disk.
- Download only through `download_document`, which re-checks your scope, decrypts and streams
  the bytes with `Cache-Control: private, no-store`. A missing or undecryptable blob answers
  404 "File is not available." — the row can exist while the file does not.
- Replace a file by patching a new `file` onto the row: the old blob is deleted once the new
  one is stored. There are no signed URLs anywhere; every read goes through the API.
- Filters: status, branch, type, registration, enquiry — all single-value exact matches, not
  lists. Search: file_name, student_name, type. Ordering: uploaded_at, expiry_date.
- `documents_expiring_soon` (query `days`, default 30) returns documents whose `expiry_date`
  falls on or before today plus that many days, ordered by expiry, already-expired included.
  The console separately colours expiry against a 90-day window; that window is a UI choice,
  not an API one.
- Transferable (entity type document) and approval-eligible; the fields a manager may apply
  from an UPDATE request are type, status and expiry_date.

## Student document (`student-documents/`): custody of a paper original

- Fields: `registration` (required), `name` (e.g. Passport, 10th Marksheet),
  `document_number`, `status` (Received, With staff, Submitted, Returned, Lost; default
  Received), `received_at` (defaults to now), `returned_at` (read-only), `remarks`, and
  `current_holder` (a user id, defaulting to the creator on the principle that whoever takes it
  in is holding it).
- `return_student_documents` {document_ids: [...]} sets Returned, stamps `returned_at`, and
  clears `current_holder` for every in-scope row not already Returned. It is written to the
  security log. Ids outside your scope are skipped rather than refused.
- Filters: registration, status, current_holder (single-value exact). Search: name,
  document_number, registration student name.
- Not transferable and not approval-eligible. Hand an original over by patching
  `current_holder` and appending a line to `remarks`; the console appends rather than
  overwrites, and so should you.

## How the two are linked in practice

- The registration form lists scans already uploaded under the candidate's name — a server
  search followed by an exact case-insensitive match — so the counsellor can see what is on
  hand before asking for it again. Two students sharing a name share that list.
- Linking an orphan scan to a registration is `update_document` {registration: id}. A document
  may belong to a registration, or to an enquiry, or to neither, but never to both.
- There is no document audit log endpoint. The console synthesises one from uploads and record
  transfers, and it omits student-document received and returned events; say so rather than
  presenting a partial history as complete.
