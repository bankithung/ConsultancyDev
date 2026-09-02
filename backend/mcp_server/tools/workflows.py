"""
Composite tools that do what a person does across several screens.

They only call existing endpoints. No business rule lives here that the API
does not already enforce: instalment schedules are built by the server, the
registration-fee Payment is created by the server, and every read is narrowed
by the caller's scope on the way out. What these tools add is the *sequence* --
the six or seven requests a counsellor's browser makes to answer one question --
and the client-side matching the API cannot do, because several of the joins a
student profile needs have no filter behind them.

Three habits run through the module:

* A section the caller may not read comes back as `{"forbidden": true}` rather
  than failing the call. A student profile is worth having with one card
  missing, and an employee must still get a briefing.
* Every walk is capped, and the two that can face a large table (`follow-ups/`
  and `installments/`) are ordered and stopped at the first row past the
  window, so the cost follows the answer rather than the table.
* Where an endpoint has the filter, the filter is used. Where it does not --
  payments by registration, enrollments by student, registrations by enquiry --
  the search box narrows and the match happens here, exactly as the web console
  does it.
"""

from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal, InvalidOperation
from typing import Any, Callable

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..client import ApiClient, ApiError
from ..server import ServerState, client_for, run_api
from .generated import validate_payload

logger = logging.getLogger('mcp_server.tools.workflows')

# Enquiry field -> Registration field.
#
# Mirrors the prefill in consultancy-dev/app/app/registrations/components/
# RegistrationForm.tsx and is checked against the catalog by
# test_mapping_only_names_fields_both_models_have, so a column renamed on
# either model fails a test rather than every conversion. The web form still
# writes the profile half of this into `student-remarks/` as prose because its
# own write shape predates the columns; Registration has had real columns for
# all of it since, and an API client should use them.
ENQUIRY_TO_REGISTRATION: tuple[tuple[str, str], ...] = (
    ('candidate_name', 'student_name'), ('email', 'email'), ('mobile', 'mobile'),
    ('father_name', 'father_name'), ('mother_name', 'mother_name'), ('permanent_address', 'permanent_address'),
    ('date_of_birth', 'date_of_birth'), ('gender', 'gender'), ('caste', 'caste'), ('religion', 'religion'),
    ('father_occupation', 'father_occupation'), ('mother_occupation', 'mother_occupation'),
    ('father_mobile', 'father_mobile'), ('mother_mobile', 'mother_mobile'),
    ('family_place', 'family_place'), ('family_state', 'family_state'),
    ('stream', 'stream'), ('school_name', 'school_name'), ('school_board', 'school_board'),
    ('school_place', 'school_place'), ('school_state', 'school_state'),
    ('class12_passing_year', 'class12_passing_year'), ('class12_percentage', 'class12_percentage'),
    ('class10_school_name', 'class10_school_name'), ('class10_board', 'class10_board'),
    ('class10_passing_year', 'class10_passing_year'), ('class10_place', 'class10_place'),
    ('class10_state', 'class10_state'), ('class10_percentage', 'class10_percentage'),
    ('physics_marks', 'physics_marks'), ('chemistry_marks', 'chemistry_marks'),
    ('biology_marks', 'biology_marks'), ('maths_marks', 'maths_marks'),
    # Copied as stored, never recomputed from the four subject marks: the
    # enquiry desk sometimes records a board-reported aggregate that does not
    # equal the average of what was typed above it, and the recorded number is
    # the one the admission depends on.
    ('pcb_percentage', 'pcb_percentage'), ('pcm_percentage', 'pcm_percentage'),
    ('previous_neet_marks', 'previous_neet_marks'), ('present_neet_marks', 'present_neet_marks'),
    ('gap_year', 'gap_year'), ('gap_year_from', 'gap_year_from'), ('gap_year_to', 'gap_year_to'),
    ('college_dropout', 'college_dropout'),
)

# Method -> the metadata keys that method's payment carries. Everything else is
# refused, so a cheque number cannot be filed under a UPI payment where no
# screen would ever show it. A method absent from this table (Bank Transfer,
# say) has no agreed shape, so its metadata is passed through unchecked.
PAYMENT_METADATA_KEYS: dict[str, tuple[str, ...]] = {
    'Cash': (),
    'Cheque': ('cheque_no', 'bank_name'),
    'UPI': ('upi_transaction_id',),
    'Card': ('card_last4', 'card_network'),
}

# `type` is a free CharField on the model; these are the three values the rest
# of the system reads. Analytics splits revenue on the first two by name.
PAYMENT_TYPES = ('Registration', 'Enrollment', 'Other')
PAYMENT_STATUSES = ('Pending', 'Success', 'Failed', 'Refunded')

SETTLED_REFUND_STATUSES = ('Approved', 'Processed')
COMPLETED_FOLLOW_UP_STATUSES = ('Completed', 'Done')

PAGE_SIZE = 200
MAX_PAGES = 20
# Pages walked when a search has come back empty and the row must be found by
# its foreign key instead. Deliberately shorter than MAX_PAGES: this is the
# unlucky path, not the normal one.
FALLBACK_PAGES = 5
DUE_SOON_DAYS = 7
EXPIRING_DOCUMENT_DAYS = 30

FORBIDDEN: dict[str, Any] = {'forbidden': True}


# --------------------------------------------------------------------- shared


def _forbidden() -> dict[str, Any]:
    return dict(FORBIDDEN)


def _is_forbidden(value: Any) -> bool:
    return isinstance(value, dict) and value.get('forbidden') is True


def _rows_of(value: Any) -> list:
    """A section's rows for arithmetic: a forbidden marker contributes nothing."""
    return value if isinstance(value, list) else []


def _section(fn: Callable[[], Any]) -> Any:
    """
    Run one section of a composite read.

    A 403 is the caller's own permissions answering, which is information
    rather than failure -- the section is marked and the rest of the profile is
    still assembled. Anything else (a 500, an unreachable backend) is a real
    failure and stops the tool, because silently returning a partial answer
    that looks complete is worse than an error.
    """
    try:
        return fn()
    except ApiError as exc:
        if exc.status == 403:
            return _forbidden()
        raise ToolError(str(exc)) from exc


def _optional(fn: Callable[[], Any]) -> Any:
    """A single record that may legitimately be missing or out of reach."""
    try:
        return fn()
    except ApiError as exc:
        if exc.status in (403, 404):
            return None
        raise ToolError(str(exc)) from exc


def _walk(client: ApiClient, path: str, params: dict | None = None, *, max_pages: int = MAX_PAGES,
          stop: Callable[[dict], bool] | None = None) -> list:
    """
    Every row on `path`, up to `max_pages` pages.

    `stop` ends the walk at the first row that fails it, which is only sound on
    an ordered listing -- and that is exactly where it is used: follow-ups
    ordered by `scheduled_for` and instalments by `due_date`, where the rows
    beyond the window cannot become relevant again further down.
    """
    query = dict(params or {})
    query.setdefault('page_size', PAGE_SIZE)
    rows: list = []
    page = 1
    while page <= max_pages:
        query['page'] = page
        body = client.get(path, params=query)
        if not isinstance(body, dict) or 'results' not in body:
            # An unpaginated endpoint answers with the whole array at once.
            return list(body or [])
        for row in body['results']:
            if stop is not None and stop(row):
                return rows
            rows.append(row)
        if page >= int(body.get('pages', 1) or 1):
            break
        page += 1
    return rows


def _page(client: ApiClient, path: str, params: dict | None = None, limit: int = 50) -> list:
    """One page of `path` as a plain list, whatever envelope it arrived in."""
    body = client.get(path, params={**(params or {}), 'page_size': limit})
    if isinstance(body, dict):
        return list(body.get('results') or [])
    return list(body or [])[:limit]


def _money(value: Any) -> float:
    """Decimals travel as strings; a missing or unparseable one is zero, not a crash."""
    if value in (None, ''):
        return 0.0
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return 0.0


def _day(value: Any) -> str:
    """
    The calendar day of a date or datetime AS THE SERVER RENDERED IT.

    Taking the first ten characters rather than parsing keeps this in the API's
    display timezone. Parsing and converting to UTC here would put a 23:00
    appointment on the previous day for any tenant not running on UTC, which is
    not the day the person looking at the screen sees.
    """
    return str(value or '')[:10]


def _name_key(value: Any) -> str:
    return str(value or '').strip().lower()


def build_registration_from_enquiry(enquiry: dict, registration_fee: Any, payment_status: str,
                                    payment_method: str, needs_loan: bool,
                                    overrides: dict | None) -> dict[str, Any]:
    """
    The registration body a human's form submit would produce from this enquiry.

    Blank values are skipped rather than copied, so an enquiry that never
    recorded a mother's occupation leaves the registration's column at its own
    default instead of writing an empty string over it.
    """
    body: dict[str, Any] = {}
    for source, destination in ENQUIRY_TO_REGISTRATION:
        value = enquiry.get(source)
        if value not in (None, ''):
            body[destination] = value

    locations = enquiry.get('preferred_locations') or []
    if isinstance(locations, str):
        locations = [locations]
    course = enquiry.get('course_interested') or ''
    if locations and course:
        # "Delhi, Mumbai" typed into one location box is two preferences, not
        # one place with a comma in it. RegistrationForm splits on submit; an
        # enquiry written through the API can still hold the joined form.
        places = [part.strip() for place in locations for part in str(place).split(',') if part.strip()]
        body['preferences'] = [{'courseName': course, 'location': place, 'priority': index}
                               for index, place in enumerate(places, start=1)]

    body['enquiry'] = enquiry['id']
    body['registration_fee'] = str(registration_fee)
    body['payment_status'] = payment_status
    body['payment_method'] = payment_method
    body['needs_loan'] = bool(needs_loan)
    body.update(overrides or {})
    return body


def _clean(catalog, resource: str, body: dict) -> dict:
    """Validate a create payload against the catalog and drop what is read-only."""
    payload = validate_payload(catalog, resource, body, partial=False)
    stripped = payload.pop('_stripped', None)
    if stripped:
        logger.info('%s: dropped read-only field(s) %s from the payload', resource, ', '.join(stripped))
    return payload


def register_workflow_tools(mcp: FastMCP, state: ServerState) -> None:
    catalog = state.catalog

    # ---------------------------------------------------------- student_360

    def _resolve_registration(client: ApiClient, enquiry: dict) -> dict | None:
        """
        The registration this enquiry became, if it became one.

        `registrations/` has no `enquiry` filter (RegistrationFilter offers
        none), and DRF answers 200 with an UNFILTERED list for a parameter it
        does not recognise -- so asking for one would look like it worked and
        return the wrong student. The search box narrows by the name the
        conversion copied across; a capped walk covers the case where either
        name was edited afterwards.
        """
        enquiry_id = enquiry['id']

        def linked(rows: Any) -> dict | None:
            for row in _rows_of(rows):
                if row.get('enquiry') == enquiry_id:
                    return row
            return None

        name = (enquiry.get('candidate_name') or '').strip()
        if name:
            found = linked(_section(lambda: _walk(client, 'registrations/', {'search': name})))
            if found:
                return found
        return linked(_section(lambda: _walk(client, 'registrations/', max_pages=FALLBACK_PAGES)))

    def student_360(ctx: Context, registration_id: int | None = None, enquiry_id: int | None = None,
                    enrollment_id: int | None = None) -> dict[str, Any]:
        given = [value for value in (registration_id, enquiry_id, enrollment_id) if value is not None]
        if len(given) != 1:
            raise ToolError('Pass exactly one of registration_id, enquiry_id or enrollment_id.')
        client = client_for(ctx, state)

        registration: dict | None = None
        enquiry: dict | None = None
        if enrollment_id is not None:
            enrollment = run_api(lambda: client.get(f'enrollments/{enrollment_id}/'))
            registration_id = enrollment.get('student')
        if registration_id is not None:
            registration = run_api(lambda: client.get(f'registrations/{registration_id}/'))
            enquiry_id = registration.get('enquiry')
            if enquiry_id:
                enquiry = _optional(lambda: client.get(f'enquiries/{enquiry_id}/'))
        else:
            enquiry = run_api(lambda: client.get(f'enquiries/{enquiry_id}/'))
            registration = _resolve_registration(client, enquiry)
            registration_id = registration['id'] if registration else None

        name = ((registration or {}).get('student_name')
                or (enquiry or {}).get('candidate_name') or '')
        key = _name_key(name)
        out: dict[str, Any] = {'student_name': name, 'enquiry': enquiry, 'registration': registration}

        # Follow-ups hang off the ENQUIRY, not the registration, and carry a
        # comment thread of their own. `follow-up-comments/` filters by one
        # follow_up at a time, so this is a request per follow-up — bounded by
        # the calls made to a single lead, which is a handful. Fetching the
        # tenant's whole comment table once and matching here would be one
        # request and orders of magnitude more rows.
        if enquiry_id:
            follow_ups = _section(lambda: _walk(client, 'follow-ups/',
                                                {'enquiry': enquiry_id, 'ordering': 'scheduled_for'}))
            for follow_up in _rows_of(follow_ups):
                follow_up['comments'] = _rows_of(_section(
                    lambda fu=follow_up: _walk(client, 'follow-up-comments/', {'follow_up': fu['id']}),
                ))
        else:
            follow_ups = []
        out['follow_ups'] = follow_ups

        if registration_id is not None:
            out['remarks'] = _section(lambda: _walk(client, 'student-remarks/', {'registration': registration_id}))
            out['physical_documents'] = _section(
                lambda: _walk(client, 'student-documents/', {'registration': registration_id}))
            out['refunds'] = _section(lambda: _walk(client, 'refunds/', {'student': registration_id}))
            # `enrollments/` has no student filter, but its search covers
            # student__student_name -- the very column `name` was read from --
            # so the search is exact by construction and the FK match only has
            # to separate two students who share a name.
            enrollments = _section(lambda: _walk(client, 'enrollments/', {'search': name})) if name else []
            if not _is_forbidden(enrollments):
                enrollments = [row for row in _rows_of(enrollments) if row.get('student') == registration_id]
        else:
            out['remarks'] = out['physical_documents'] = out['refunds'] = []
            enrollments = []
        out['enrollments'] = enrollments
        enrollment_ids = {row['id'] for row in _rows_of(enrollments)}

        # `payments/` has no registration or enrollment filter either, and
        # unlike enrollments its student_name is a SNAPSHOT taken when the
        # payment was written: renaming a student later leaves older payments
        # under the old name and out of this search. That is the console's
        # behaviour too, and the alternative -- walking the payments table for
        # every profile -- costs far more than the rows it would recover.
        def is_this_students_payment(row: dict) -> bool:
            if registration_id is not None and row.get('registration') == registration_id:
                return True
            if row.get('enrollment') is not None and row.get('enrollment') in enrollment_ids:
                return True
            if row.get('registration') is None and row.get('enrollment') is None:
                return _name_key(row.get('student_name')) == key
            return False

        payments = _section(lambda: _walk(client, 'payments/', {'search': name})) if name else []
        out['payments'] = (payments if _is_forbidden(payments)
                           else [row for row in _rows_of(payments) if is_this_students_payment(row)])

        # Scans link to exactly one of registration or enquiry, so both sides
        # are asked for and the results concatenated.
        documents: list = []
        forbidden_documents = False
        for param, value in (('registration', registration_id), ('enquiry', enquiry_id)):
            if not value:
                continue
            rows = _section(lambda p=param, v=value: _walk(client, 'documents/', {p: v}))
            forbidden_documents = forbidden_documents or _is_forbidden(rows)
            documents.extend(_rows_of(rows))
        out['documents'] = _forbidden() if forbidden_documents and not documents else documents

        def matches_name_or_student(row: dict) -> bool:
            if registration_id is not None and row.get('student') == registration_id:
                return True
            return _name_key(row.get('student_name')) == key

        visa = _section(lambda: _walk(client, 'visa-tracking/', {'search': name})) if name else []
        out['visa'] = (visa if _is_forbidden(visa)
                       else [row for row in _rows_of(visa) if matches_name_or_student(row)])

        appointments = _section(lambda: _walk(client, 'appointments/', {'search': name})) if name else []
        out['appointments'] = (appointments if _is_forbidden(appointments)
                               else [row for row in _rows_of(appointments)
                                     if _name_key(row.get('student_name')) == key])

        subjects = {('enquiry', enquiry_id), ('registration', registration_id)}
        subjects |= {('enrollment', value) for value in enrollment_ids}
        subjects = {pair for pair in subjects if pair[1] is not None}

        # `transfers.entity_type` is a single-value exact filter (the viewset
        # declares filterset_fields, not a MultiValueFilter FilterSet), so
        # repeating the key would filter on the LAST value alone and silently
        # drop the other two kinds. One narrowed walk per kind instead.
        transfers: Any = []
        forbidden_transfers = False
        for kind in sorted({entity_type for entity_type, _ in subjects}):
            rows = _section(lambda k=kind: _walk(client, 'transfers/', {'entity_type': k}))
            forbidden_transfers = forbidden_transfers or _is_forbidden(rows)
            transfers.extend(row for row in _rows_of(rows)
                             if (row.get('entity_type'), row.get('entity_id')) in subjects)
        out['transfers'] = _forbidden() if forbidden_transfers and not transfers else transfers

        # `approval-requests/` declares no filters at all, so this one is a walk.
        approvals = _section(lambda: _walk(client, 'approval-requests/', {'ordering': '-created_at'}))
        out['pending_approvals'] = (approvals if _is_forbidden(approvals)
                                    else [row for row in _rows_of(approvals)
                                          if row.get('status') == 'PENDING'
                                          and (row.get('entity_type'), row.get('entity_id')) in subjects])

        settled = _rows_of(out['payments'])
        refunds = _rows_of(out['refunds'])
        paid = sum(_money(row.get('amount')) for row in settled if row.get('status') == 'Success')
        refunded = sum(_money(row.get('amount')) for row in refunds
                       if row.get('status') in SETTLED_REFUND_STATUSES)
        out['totals'] = {
            'paid': paid,
            'pending': sum(_money(row.get('amount')) for row in settled if row.get('status') == 'Pending'),
            'refunded': refunded,
            'net': paid - refunded,
            'total_fees': sum(_money(row.get('total_fees')) for row in _rows_of(enrollments)),
            'outstanding_installments': sum(
                _money(item.get('amount'))
                for row in _rows_of(enrollments) for item in (row.get('installments') or [])
                if item.get('status') != 'Paid'
            ),
        }
        return out

    # ------------------------------------------------------------- the writes

    def convert_enquiry_to_registration(ctx: Context, enquiry_id: int, registration_fee: str,
                                        payment_status: str = 'Pending', payment_method: str = 'Cash',
                                        needs_loan: bool = False, overrides: dict[str, Any] | None = None,
                                        mark_converted: bool = True) -> dict[str, Any]:
        client = client_for(ctx, state)
        enquiry = run_api(lambda: client.get(f'enquiries/{enquiry_id}/'))
        body = build_registration_from_enquiry(enquiry, registration_fee, payment_status,
                                               payment_method, needs_loan, overrides)
        payload = _clean(catalog, 'registrations', body)
        registration = run_api(lambda: client.post('registrations/', json=payload))
        if mark_converted and enquiry.get('status') != 'Converted':
            try:
                client.patch(f'enquiries/{enquiry_id}/', json={'status': 'Converted'})
            except ApiError as exc:
                # The registration exists and re-running would duplicate it, so
                # this is reported alongside the result rather than raised.
                registration['_warning'] = (f'Registration created, but enquiry {enquiry_id} could not be '
                                            f'marked Converted: {exc}')
        return registration

    def enroll_student(ctx: Context, registration_id: int, program_name: str, start_date: str,
                       duration_months: int, total_fees: str, university: int | None = None,
                       university_name: str = '', country: str = '', installments_count: int = 0,
                       installment_amount: str | None = None,
                       commission_amount: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            'student': registration_id, 'program_name': program_name, 'start_date': start_date,
            'duration_months': int(duration_months), 'total_fees': str(total_fees),
            'university_name': university_name, 'country': country,
        }
        if university:
            body['university'] = university
        if installments_count:
            body['installments_count'] = int(installments_count)
        if installment_amount is not None:
            body['installment_amount'] = str(installment_amount)
        if commission_amount is not None:
            body['commission_amount'] = str(commission_amount)
        payload = _clean(catalog, 'enrollments', body)
        client = client_for(ctx, state)
        return run_api(lambda: client.post('enrollments/', json=payload))

    def record_payment(ctx: Context, amount: str, method: str = 'Cash', type: str = 'Enrollment',
                       registration: int | None = None, enrollment: int | None = None,
                       installment: int | None = None, student_name: str | None = None,
                       reference: str = '', status: str = 'Success',
                       metadata: dict[str, Any] | None = None, date: str | None = None) -> dict[str, Any]:
        if type not in PAYMENT_TYPES:
            raise ToolError(f'type must be one of {", ".join(PAYMENT_TYPES)}; got {type!r}.')
        if status not in PAYMENT_STATUSES:
            raise ToolError(f'status must be one of {", ".join(PAYMENT_STATUSES)}; got {status!r}. '
                            'Only Success counts as revenue.')
        detail = dict(metadata or {})
        if method in PAYMENT_METADATA_KEYS:
            expected = PAYMENT_METADATA_KEYS[method]
            missing = [key for key in expected if not detail.get(key)]
            unexpected = sorted(key for key in detail if key not in expected)
            if missing or unexpected:
                wanted = ', '.join(expected) or '(none)'
                problem = []
                if missing:
                    problem.append(f'missing {", ".join(missing)}')
                if unexpected:
                    problem.append(f'unexpected {", ".join(unexpected)}')
                raise ToolError(f'metadata for a {method} payment holds exactly: {wanted}. '
                                f'This one has {" and ".join(problem)}.')

        client = client_for(ctx, state)
        if not student_name:
            if registration:
                student_name = run_api(lambda: client.get(f'registrations/{registration}/'))['student_name']
            elif enrollment:
                student_name = run_api(lambda: client.get(f'enrollments/{enrollment}/'))['student_name']
            else:
                raise ToolError('Provide student_name, or a registration or enrollment to derive it from.')

        body: dict[str, Any] = {
            'amount': str(amount), 'method': method, 'type': type, 'status': status,
            'reference': reference, 'student_name': student_name, 'metadata': detail,
        }
        for field, value in (('registration', registration), ('enrollment', enrollment),
                             ('installment', installment), ('date', date)):
            if value:
                body[field] = value
        payload = _clean(catalog, 'payments', body)
        return run_api(lambda: client.post('payments/', json=payload))

    # ------------------------------------------------------ search and briefing

    SEARCH_GROUPS = (
        ('enquiries', 'enquiries/'), ('registrations', 'registrations/'), ('enrollments', 'enrollments/'),
        ('payments', 'payments/'), ('documents', 'documents/'), ('visa', 'visa-tracking/'),
        ('follow_ups', 'follow-ups/'), ('tasks', 'tasks/'), ('appointments', 'appointments/'),
        ('users', 'users/'),
    )

    def search_everything(ctx: Context, query: str, limit: int = 10) -> dict[str, Any]:
        if not query or not query.strip():
            raise ToolError('query must not be empty.')
        query = query.strip()
        limit = max(1, min(int(limit), 50))
        client = client_for(ctx, state)

        groups: dict[str, Any] = {}
        counts: dict[str, int] = {}
        for key, path in SEARCH_GROUPS:
            try:
                body = client.get(path, params={'search': query, 'page_size': limit})
            except ApiError as exc:
                if exc.status != 403:
                    raise ToolError(str(exc)) from exc
                # `users/` is the one group a tenant can close off, and losing
                # it must not lose the other nine.
                groups[key], counts[key] = [], 0
                continue
            if isinstance(body, dict):
                rows = list(body.get('results') or [])[:limit]
                counts[key] = int(body.get('count', len(rows)) or 0)
            else:
                rows = list(body or [])[:limit]
                counts[key] = len(body or [])
            groups[key] = rows

        return {'query': query, 'limit': limit, 'counts': counts,
                'total': sum(counts.values()), **groups}

    def daily_briefing(ctx: Context, date: str | None = None) -> dict[str, Any]:
        try:
            day = dt.date.fromisoformat(date) if date else dt.date.today()
        except (TypeError, ValueError):
            raise ToolError(f'date must be YYYY-MM-DD; got {date!r}.') from None
        today = day.isoformat()
        horizon = (day + dt.timedelta(days=DUE_SOON_DAYS)).isoformat()
        client = client_for(ctx, state)

        # Ordered ascending and stopped at the first row past the day, so the
        # cost of this walk is the number of follow-ups still open rather than
        # the size of the table. `follow-ups/` has no date filter.
        follow_ups = _section(lambda: _walk(
            client, 'follow-ups/', {'ordering': 'scheduled_for'},
            stop=lambda row: _day(row.get('scheduled_for')) > today,
        ))
        due = [row for row in _rows_of(follow_ups)
               if row.get('status') not in COMPLETED_FOLLOW_UP_STATUSES]
        overdue_follow_ups = [row for row in due if _day(row.get('scheduled_for')) < today]

        appointments = _section(lambda: client.get('appointments/calendar/',
                                                   params={'month': day.month, 'year': day.year}))
        appointments_today = ([] if _is_forbidden(appointments)
                              else [row for row in _rows_of(appointments) if _day(row.get('date')) == today])

        # Same trick on `installments/`, which has no filters at all but does
        # order by due_date.
        installments = _section(lambda: _walk(
            client, 'installments/', {'ordering': 'due_date'},
            stop=lambda row: _day(row.get('due_date')) > horizon,
        ))
        unpaid = [row for row in _rows_of(installments) if row.get('status') != 'Paid']
        overdue_installments = [row for row in unpaid if _day(row.get('due_date')) < today]
        due_soon = [row for row in unpaid if today <= _day(row.get('due_date')) <= horizon]
        if unpaid:
            _name_installments(client, overdue_installments + due_soon)

        expiring = _section(lambda: _page(client, 'documents/expiring-soon/',
                                          {'days': EXPIRING_DOCUMENT_DAYS}, limit=100))
        transfer_inbox = _section(lambda: _page(client, 'transfers/inbox/'))
        unread = _section(lambda: client.get('notifications/unread-count/'))
        overview = _section(lambda: client.get('analytics/overview/'))
        approvals = _section(lambda: {
            'count': int((client.get('approval-requests/pending-count/') or {}).get('count', 0)),
            'results': [row for row in _page(client, 'approval-requests/', {'ordering': '-created_at'})
                        if row.get('status') == 'PENDING'],
        })

        return {
            'date': today,
            'follow_ups_due': follow_ups if _is_forbidden(follow_ups) else due,
            'overdue_follow_ups': follow_ups if _is_forbidden(follow_ups) else overdue_follow_ups,
            'appointments_today': appointments if _is_forbidden(appointments) else appointments_today,
            'overdue_installments': installments if _is_forbidden(installments) else overdue_installments,
            'installments_due_soon': installments if _is_forbidden(installments) else due_soon,
            'expiring_documents': expiring,
            'pending_approvals': approvals,
            'transfer_inbox': transfer_inbox,
            'unread_notifications': (unread if _is_forbidden(unread)
                                     else int((unread or {}).get('count', 0))),
            'overview': overview,
        }

    def _name_installments(client: ApiClient, rows: list) -> None:
        """
        Add enrollment_no and student_name to instalment rows, in place.

        InstallmentSerializer carries only the enrollment id, and a briefing
        line reading "300.00 due" without a name is not actionable. One walk of
        `enrollments/` builds the lookup rather than fetching each enrollment,
        so the cost does not grow with the number of overdue rows.
        """
        if not rows:
            return
        enrollments = _section(lambda: _walk(client, 'enrollments/'))
        if _is_forbidden(enrollments):
            return
        by_id = {row['id']: row for row in _rows_of(enrollments)}
        for row in rows:
            enrollment = by_id.get(row.get('enrollment'))
            if enrollment:
                row['enrollment_no'] = enrollment.get('enrollment_no')
                row['student_name'] = enrollment.get('student_name')

    # ------------------------------------------------------------ registration

    student_360.__doc__ = (
        'Everything about one student in one call, resolved from EXACTLY ONE of registration_id, '
        'enquiry_id or enrollment_id (an enrollment resolves through its student FK; an enquiry through '
        'the registration that names it). Returns student_name, enquiry, registration, follow_ups (each '
        'with its comments), remarks, physical_documents (originals held at the counter), enrollments '
        '(each with its installments), payments, refunds, documents (encrypted scans), visa, appointments, '
        'transfers and pending_approvals touching the record, and totals {paid, pending, refunded, net, '
        'total_fees, outstanding_installments} where only Success payments count as paid and only '
        'Approved/Processed refunds as refunded. Payments, enrollments, visa records and appointments are '
        'found by searching the student name and matching the foreign key here, because those endpoints '
        'have no filter for it — a payment written before a rename keeps the old name and can be missed. '
        'Any section your role may not read comes back as {"forbidden": true} instead of failing the call.'
    )
    convert_enquiry_to_registration.__doc__ = (
        'Convert an enquiry into a registration the way the web form does (POST /api/registrations/): copy '
        'the candidate details and the whole academic and family profile across, link the new registration '
        'by `enquiry`, then set the enquiry status to Converted (pass mark_converted=false to leave it). '
        'The server assigns registration_no and creates the registration-fee Payment — type Registration, '
        'status Success only when payment_status is "Paid" (any case), otherwise Pending — so do not record '
        'that payment yourself. registration_fee is required. `overrides` is a dict of registration fields '
        'that replace copied values (for example a corrected mobile); an unknown field is refused before '
        'anything is written. A 404 means the enquiry is missing or outside your scope.'
    )
    enroll_student.__doc__ = (
        'Enroll a registered student on a program (POST /api/enrollments/). start_date is YYYY-MM-DD. With '
        'installments_count > 0 the SERVER builds that many Installment rows: amounts sum exactly to '
        'total_fees (the last absorbs the rounding) and due dates step whole calendar months from '
        'start_date. installment_amount optionally fixes the per-row amount. Never build a schedule '
        'yourself — installments cannot be created directly. Returns the enrollment with its installments; '
        'enrollment_no is server-assigned.'
    )
    record_payment.__doc__ = (
        'Record a payment (POST /api/payments/). Link it to a registration and/or an enrollment, and to an '
        'installment when settling one. type: Registration, Enrollment or Other. status: Pending, Success, '
        'Failed or Refunded — only Success counts as revenue. Method-specific detail goes in `metadata`, '
        'which must hold exactly the keys for the method: Cheque cheque_no and bank_name, UPI '
        'upi_transaction_id, Card card_last4 and card_network, Cash none. student_name is read from the '
        'linked registration or enrollment when omitted. Do not use this for a registration fee — creating '
        'the registration already books it.'
    )
    search_everything.__doc__ = (
        'Search enquiries, registrations, enrollments, payments, documents, visa records, follow-ups, '
        'tasks, appointments and users for `query` in one call, each through its own endpoint\'s search '
        'fields. Returns one list per group holding at most `limit` rows (1-50, default 10), plus `counts` '
        'with the true number of matches per group so you can tell a full group from a truncated one, and '
        '`total`. Everything is scoped to you: an employee searches their own records. A group your role '
        'cannot read comes back empty rather than failing the search.'
    )
    daily_briefing.__doc__ = (
        'What needs attention on `date` (YYYY-MM-DD; defaults to today on the machine running this server). '
        'Returns follow_ups_due (scheduled on or before that day and not Completed) and overdue_follow_ups, '
        'appointments_today, overdue_installments and installments_due_soon (unpaid, within seven days) each '
        'named with their enrollment and student, expiring_documents (expiry within 30 days, already-expired '
        'included), pending_approvals {count, results}, transfer_inbox (awaiting your decision), '
        'unread_notifications and the overview analytics. Every section is scoped to you, and one your role '
        'cannot read comes back as {"forbidden": true} so the rest of the briefing still arrives.'
    )

    def add(fn, name: str, annotations: ToolAnnotations) -> None:
        mcp.add_tool(fn, name=name, description=(fn.__doc__ or '').strip(),
                     structured_output=True, annotations=annotations)

    add(student_360, 'student_360', ToolAnnotations(title='Student 360', readOnlyHint=True))
    add(search_everything, 'search_everything', ToolAnnotations(title='Search everything', readOnlyHint=True))
    add(daily_briefing, 'daily_briefing', ToolAnnotations(title='Daily briefing', readOnlyHint=True))

    if not state.settings.read_only:
        # Writes, none of them destructive and none idempotent: converting the
        # same enquiry twice makes two registrations, and so does recording the
        # same payment twice.
        for fn, name, title in (
            (convert_enquiry_to_registration, 'convert_enquiry_to_registration', 'Convert enquiry'),
            (enroll_student, 'enroll_student', 'Enroll student'),
            (record_payment, 'record_payment', 'Record payment'),
        ):
            add(fn, name, ToolAnnotations(title=title, readOnlyHint=False,
                                          destructiveHint=False, idempotentHint=False))
