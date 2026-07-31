import logging

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.http import Http404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

logger = logging.getLogger('core')


def api_exception_handler(exc, context):
    """
    Return structured errors without leaking internals.

    DRF's default handler passes anything that isn't an APIException straight
    through to Django, which renders a debug traceback (or a bare 500). Both
    leak: the traceback exposes settings and SQL, and `str(exc)` on an
    IntegrityError carries table and constraint names. We translate the common
    non-API exceptions ourselves and log the detail server-side instead.
    """
    response = drf_exception_handler(exc, context)
    view = context.get('view').__class__.__name__ if context.get('view') else 'unknown'

    if response is not None:
        # Normalise the body shape so clients have one thing to parse.
        detail = response.data
        if isinstance(detail, dict) and 'detail' in detail and len(detail) == 1:
            response.data = {'error': str(detail['detail'])}
        else:
            response.data = {'error': 'Validation failed', 'fields': detail}
        return response

    if isinstance(exc, Http404):
        return Response({'error': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

    if isinstance(exc, DjangoValidationError):
        return Response(
            {'error': 'Validation failed', 'fields': exc.message_dict
             if hasattr(exc, 'message_dict') else list(exc.messages)},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if isinstance(exc, IntegrityError):
        # Never surface the raw message: it names tables and constraints.
        logger.warning('IntegrityError in %s: %s', view, exc, exc_info=True)
        return Response(
            {'error': 'That operation conflicts with existing data.'},
            status=status.HTTP_409_CONFLICT,
        )

    logger.error('Unhandled exception in %s: %s', view, exc, exc_info=True)
    return Response(
        {'error': 'An unexpected error occurred.'},
        status=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
