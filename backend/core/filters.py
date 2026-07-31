"""
Query-string filters for the CRM list endpoints.

`filterset_fields` on a ViewSet generates one exact-match filter per field,
which can only ever express "status = New". A multi-select control needs
"status is any of New or Contacted", so the filters below take over wherever
the UI offers one.

VALUES ARRIVE AS REPEATED QUERY PARAMETERS -- `?status=New&status=Contacted`.

django-filter ships CSV filters that would read `?status=New,Contacted`
instead, and they are the wrong choice for this data: a school board in this
vocabulary is literally "SEBA (Board of Secondary Education, Assam)". Splitting
that on commas yields two fragments that match no row, and nothing anywhere
reports an error -- the user just sees an empty table. Repeated parameters have
no escaping problem to get wrong.
"""

import json

from django import forms
from django.core.exceptions import ValidationError
from django.db.models import Q, TextField
from django.db.models.functions import Cast
from django_filters import rest_framework as filters

from .models import (
    Appointment, Enquiry, Enrollment, FollowUp, Payment, Refund, Registration,
)


class MultiValueWidget(forms.TextInput):
    """
    Reads EVERY repetition of a parameter.

    The default widget calls `data.get(name)`, which on a QueryDict returns only
    the last occurrence -- so `?status=New&status=Closed` would filter on
    "Closed" alone and look like it had worked.
    """

    def value_from_datadict(self, data, files, name):
        if hasattr(data, 'getlist'):
            raw = data.getlist(name)
        else:
            single = data.get(name)
            raw = [] if single is None else [single]
        # A cleared control can leave `&status=` behind; an empty string is not
        # a value to match on.
        return [value for value in (item.strip() for item in raw) if value]


class MultiValueField(forms.Field):
    """A list-valued form field; `coerce` converts and validates each entry."""

    widget = MultiValueWidget

    def __init__(self, *args, coerce=None, **kwargs):
        self.coerce = coerce
        super().__init__(*args, **kwargs)

    def clean(self, value):
        values = list(value or [])
        if self.coerce is None:
            return values

        cleaned = []
        for raw in values:
            try:
                cleaned.append(self.coerce(raw))
            except (TypeError, ValueError):
                raise ValidationError(
                    '"%(value)s" is not a valid value.',
                    code='invalid',
                    params={'value': raw},
                )
        return cleaned


class MultiValueFilter(filters.Filter):
    """`?field=a&field=b` -> `field__in=[a, b]`. Absent or empty: no filtering."""

    field_class = MultiValueField

    def filter(self, qs, value):
        if not value:
            return qs
        return self.get_method(qs)(**{f'{self.field_name}__in': value})


class MultiValueIdFilter(MultiValueFilter):
    """
    The same, for foreign keys.

    Coercing here rather than leaving it to the ORM matters: `?owner=abc` would
    otherwise reach `int()` deep inside query compilation and surface as a 500.
    A bad id in a query string is a client error, so it answers 400.
    """

    def __init__(self, *args, **kwargs):
        kwargs.setdefault('coerce', int)
        super().__init__(*args, **kwargs)


class JSONContainsAnyFilter(MultiValueFilter):
    """
    Matches rows whose JSON column contains ANY of the given values.

    `preferred_locations__contains=['Kota']` would be the direct expression, but
    the `contains` lookup on a JSONField is unsupported on SQLite -- the
    development database here -- so it raises rather than returning rows. Cast
    to text and match the JSON-encoded value instead, which behaves the same on
    SQLite and PostgreSQL.

    The value is matched WITH its surrounding quotes (`"Kota"`), so a shorter
    place name cannot match inside a longer one.

    KNOWN LIMIT: on a list of objects -- `Registration.preferences` is
    `[{"courseName": ..., "location": ...}]` -- this matches the value under
    ANY key, not a named one. Courses and place names are disjoint vocabularies
    here so the two cannot collide, and anchoring on `"courseName": "..."`
    instead would make the filter depend on the exact whitespace `json.dumps`
    happened to use when the row was written.
    """

    def filter(self, qs, value):
        if not value:
            return qs

        # Two filters can point at the same column (course and location both
        # read `preferences`). Annotating the same alias twice is a hard error,
        # so the cast is shared.
        alias = f'_{self.field_name}_text'
        if alias not in qs.query.annotations:
            qs = qs.annotate(**{alias: Cast(self.field_name, output_field=TextField())})

        matches = Q()
        for item in value:
            matches |= Q(**{f'{alias}__icontains': json.dumps(item)})
        return self.get_method(qs)(matches)


class EnquiryFilter(filters.FilterSet):
    """
    Backs the enquiry directory's filter drawer.

    Every control the drawer offers is here, because a filter applied on the
    client can only narrow the page already fetched -- with 25 rows a page that
    silently hides matches and reports a row count that disagrees with the
    table. `owner` and `branch` also keep the older single-value call sites
    working: one value is just a list of one.
    """

    status = MultiValueFilter(field_name='status')
    stream = MultiValueFilter(field_name='stream')
    course_interested = MultiValueFilter(field_name='course_interested')
    gender = MultiValueFilter(field_name='gender')
    caste = MultiValueFilter(field_name='caste')
    school_board = MultiValueFilter(field_name='school_board')
    family_state = MultiValueFilter(field_name='family_state')
    preferred_locations = JSONContainsAnyFilter(field_name='preferred_locations')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')
    created_by = MultiValueIdFilter(field_name='created_by')

    class Meta:
        model = Enquiry
        fields = []


class RegistrationFilter(filters.FilterSet):
    """
    Backs the Registrations tab of the admissions directory.

    `course` and `location` both read `preferences`, the JSON list of study
    choices. They used to be applied in the browser against whichever page was
    loaded, which meant a consultancy with 200 registrations could filter to
    "Kota" and be told there were none -- because none happened to be in the
    first 25 rows.
    """

    payment_status = MultiValueFilter(field_name='payment_status')
    payment_method = MultiValueFilter(field_name='payment_method')
    stream = MultiValueFilter(field_name='stream')
    gender = MultiValueFilter(field_name='gender')
    caste = MultiValueFilter(field_name='caste')
    school_board = MultiValueFilter(field_name='school_board')
    family_state = MultiValueFilter(field_name='family_state')
    course = JSONContainsAnyFilter(field_name='preferences')
    location = JSONContainsAnyFilter(field_name='preferences')
    needs_loan = filters.BooleanFilter(field_name='needs_loan')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')
    created_by = MultiValueIdFilter(field_name='created_by')

    class Meta:
        model = Registration
        fields = []


class FollowUpFilter(filters.FilterSet):
    """
    Backs the follow-up board's filter drawer.

    `type`, `status` and `priority` are free CharFields with no `choices` on the
    model, so nothing here validates against an enum -- the drawer offers the
    values the rest of the app writes, and a value that has drifted matches
    nothing rather than erroring. `outcome_status` and `admission_possibility`
    ARE choice fields, and are how a counsellor answers "show me everyone who
    said they were still deciding".
    """

    status = MultiValueFilter(field_name='status')
    priority = MultiValueFilter(field_name='priority')
    type = MultiValueFilter(field_name='type')
    outcome_status = MultiValueFilter(field_name='outcome_status')
    admission_possibility = MultiValueFilter(field_name='admission_possibility')
    assigned_to = MultiValueIdFilter(field_name='assigned_to')
    enquiry = MultiValueIdFilter(field_name='enquiry')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')

    class Meta:
        model = FollowUp
        fields = []


class AppointmentFilter(filters.FilterSet):
    """
    Backs the Appointments tab of the engagements screen.

    `AppointmentViewSet` declared no filters at all. `?status=Scheduled` was
    therefore discarded and answered 200 with the UNFILTERED list, which is why
    the old appointments page offered no status control over its paginated list
    -- the only place it dared filter was the calendar, whose month set is
    complete and could honestly be narrowed in the browser.

    `type` and `status` ARE `choices` fields on the model, but nothing here
    validates against them: an unrecognised value must match no row rather than
    400, so a stale bookmark shows an empty board instead of an error page.
    """

    status = MultiValueFilter(field_name='status')
    type = MultiValueFilter(field_name='type')
    counselor = MultiValueIdFilter(field_name='counselor')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')
    created_by = MultiValueIdFilter(field_name='created_by')

    class Meta:
        model = Appointment
        fields = []


class PaymentFilter(filters.FilterSet):
    """
    Backs the Transactions tab of the payments screen.

    The viewset previously declared `filterset_fields`, which generates one
    single-value exact-match filter per field. Those use the default widget,
    which reads `data.get(name)` -- so a multi-select sending
    `?status=Success&status=Pending` filtered on "Pending" ALONE. The table
    narrowed, which reads as the control having worked, while every Success row
    silently disappeared. That is worse than the unfiltered case, because there
    is nothing on screen to notice.
    """

    status = MultiValueFilter(field_name='status')
    type = MultiValueFilter(field_name='type')
    method = MultiValueFilter(field_name='method')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')
    created_by = MultiValueIdFilter(field_name='created_by')

    class Meta:
        model = Payment
        fields = []


class RefundFilter(filters.FilterSet):
    """
    Backs the Refunds tab of the payments screen.

    `RefundViewSet` declared no filters at all. The standalone refunds page
    still rendered a status dropdown over it, and DRF discards a parameter it
    does not recognise and answers 200 with the UNFILTERED list -- so choosing
    "Rejected" left every refund on screen and looked like there simply were no
    others.

    `payment` is registered for the same reason: `listRefundsForPayment` had to
    fetch a page and filter in the browser because `?payment=<id>` was ignored.
    """

    status = MultiValueFilter(field_name='status')
    student = MultiValueIdFilter(field_name='student')
    payment = MultiValueIdFilter(field_name='payment')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')
    created_by = MultiValueIdFilter(field_name='created_by')

    class Meta:
        model = Refund
        fields = []


class EnrollmentFilter(filters.FilterSet):
    """Backs the Enrollments tab of the admissions directory."""

    status = MultiValueFilter(field_name='status')
    country = MultiValueFilter(field_name='country')
    program_name = MultiValueFilter(field_name='program_name')
    university = MultiValueIdFilter(field_name='university')
    branch = MultiValueIdFilter(field_name='branch')
    owner = MultiValueIdFilter(field_name='owner')
    created_by = MultiValueIdFilter(field_name='created_by')

    class Meta:
        model = Enrollment
        fields = []
