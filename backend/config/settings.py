"""
Django settings for config project.

Security posture: every default here is the SAFE one. Enabling something
permissive (DEBUG, open CORS, a throwaway SECRET_KEY) requires an explicit
environment variable, so a missing/mistyped var fails closed rather than open.
"""

from pathlib import Path
from datetime import timedelta
import os

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv
import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / '.env')


def env_bool(name, default=False):
    """Parse a boolean env var tolerantly ('1', 'true', 'yes', 'on')."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def env_list(name, default=None):
    raw = os.getenv(name, '')
    values = [item.strip() for item in raw.split(',') if item.strip()]
    return values or list(default or [])


# ---------------------------------------------------------------- core flags

# Insecure-by-default is how staging secrets end up in production. Opt in.
DEBUG = env_bool('DEBUG', False)

SECRET_KEY = os.getenv('SECRET_KEY')
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured(
            'SECRET_KEY environment variable is required when DEBUG is off. '
            'Generate one with: python -c "from django.core.management.utils '
            'import get_random_secret_key; print(get_random_secret_key())"'
        )
    # Local development only. Never reused across environments.
    SECRET_KEY = 'dev-only-insecure-key-do-not-use-outside-local-development'

ALLOWED_HOSTS = env_list('ALLOWED_HOSTS', ['localhost', '127.0.0.1'] if DEBUG else [])
if not DEBUG and not ALLOWED_HOSTS:
    raise ImproperlyConfigured('ALLOWED_HOSTS must be set when DEBUG is off.')


# ------------------------------------------------------------------ app defn

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'rest_framework_simplejwt.token_blacklist',  # server-side token revocation
    'django_filters',
    'corsheaders',
    'core',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    # POSITION IS LOAD-BEARING, and this is the only correct place for it.
    #
    # Response middleware runs BOTTOM-UP, so sitting near the top means gzip is
    # the LAST thing to touch the body — after every other middleware has
    # finished writing to it. Placing it lower would compress a body that
    # CommonMiddleware or a future ConditionalGetMiddleware then tries to
    # measure or rewrite.
    #
    # It is above WhiteNoise ON PURPOSE. WhiteNoise short-circuits static-file
    # requests and returns without calling anything below it, so anything
    # placed after WhiteNoise never sees a static response at all. Above it,
    # gzip covers static assets WhiteNoise could not serve pre-compressed, and
    # skips the ones it could — GZipMiddleware declines any response that
    # already carries a Content-Encoding header.
    #
    # See core/middleware.py for the BREACH assessment and for which responses
    # this subclass refuses to compress.
    'core.middleware.ApiGZipMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

AUTH_USER_MODEL = 'core.User'

ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
ASGI_APPLICATION = 'config.asgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]


# ---------------------------------------------------------------------- CORS

# Wide-open CORS is a development affordance, never a production one.
if DEBUG:
    CORS_ALLOW_ALL_ORIGINS = True
else:
    CORS_ALLOWED_ORIGINS = env_list('CORS_ALLOWED_ORIGINS')
    if not CORS_ALLOWED_ORIGINS:
        raise ImproperlyConfigured('CORS_ALLOWED_ORIGINS must be set when DEBUG is off.')
CORS_ALLOW_CREDENTIALS = True

CSRF_TRUSTED_ORIGINS = env_list('CSRF_TRUSTED_ORIGINS')


# ---------------------------------------------------------------- throttling

def _throttle_rates(debug):
    """
    Per-scope request rates, relaxed for development.

    DERIVED FROM `DEBUG` RATHER THAN A DEDICATED ENV VAR. A separate knob would
    be a second way to fail open: it could be left permissive in production
    while DEBUG stayed off and nothing would complain. DEBUG is already the one
    flag that must be false in production, and this file refuses to start with
    it off unless SECRET_KEY, ALLOWED_HOSTS and CORS_ALLOWED_ORIGINS are all
    set — so it is the switch least likely to be wrong by accident. The CORS
    block above makes the same call for the same reason.

    WHERE THE PRODUCTION NUMBERS COME FROM

    One page in this app fires ~20 requests: the list, its envelope counts, the
    stats aggregate, and whatever lookups the filters need. A counsellor moving
    briskly opens ~2 pages a minute, so sustained work is ~40 req/min, or about
    2400/hour. The previous 1000/hour sat BELOW that floor, which is why
    ordinary browsing produced "Request was throttled. Expected available in
    1006 seconds" instead of protecting anything.

        sustained : ~2400/hour of real work, x2 headroom  ->  5000/hour
        burst     : 20 req/page x 6 pages/min            ->   120/min

    THE TWO BUCKETS DO DIFFERENT JOBS. DRF's SimpleRateThrottle keeps a sliding
    window of request timestamps, so a single hourly bucket punishes exactly
    the pattern this app has — a burst of page loads spends the budget, and the
    user then stays locked out through the idle time that follows. The short
    window absorbs the bursts. The hourly window is what actually caps a
    runaway client, since 120/min sustained (7200/hour) would breach it well
    before the hour is out.

    What 5000/hour is protecting: a stolen token paging `page_size=100` lists
    is held to roughly 8000 rows a minute rather than unbounded. That is a
    brake on bulk exfiltration, not a defence against a patient attacker.
    Raising it weakens that brake — which is the thing to weigh, rather than
    doubling the number because someone hit a limit once.

    ACCURACY DEPENDS ON A SHARED CACHE. Throttle counters live in the Django
    cache. With the LocMemCache fallback (see CACHES below) they are PER
    PROCESS: under gunicorn with N workers each worker keeps its own tally, so
    the effective limit is N times the number configured, and which worker a
    request lands on is not deterministic — so the limit is not reproducible
    either. Set REDIS_CACHE_URL (or REDIS_URL) in production for these numbers
    to mean what they say.
    """
    if debug:
        # Generous enough that a person plus automated browsing never trips it.
        # Deliberately not `None`: a scope with no rate means the throttle code
        # path is never exercised locally and breaks first in production.
        rates = {
            'anon': '1000/min',
            'user_burst': '600/min',
            'user': '20000/hour',
        }
    else:
        rates = {
            'anon': '30/min',
            'user_burst': '120/min',
            'user': '5000/hour',
        }

    # IDENTICAL IN BOTH ENVIRONMENTS. These are credential-stuffing and
    # account-spam defences, not capacity limits. Relaxing them for local
    # convenience would mean the control is never exercised until the day it
    # matters; if that makes testing awkward, the awkwardness is the point.
    rates['login'] = '8/min'
    rates['signup'] = '5/hour'
    return rates


# ----------------------------------------------------------------------- DRF

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    # Deny by default. Public endpoints opt out explicitly via get_permissions().
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_PAGINATION_CLASS': 'core.pagination.StandardPagination',
    'PAGE_SIZE': 25,
    'DEFAULT_FILTER_BACKENDS': (
        # Without this, an unrecognised query param like ?status=New is
        # silently discarded and the endpoint returns 200 with unfiltered
        # data — a wrong answer that looks right.
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ),
    # Every class here runs on every request and the first to refuse wins, so
    # the burst and sustained buckets stack rather than override each other.
    'DEFAULT_THROTTLE_CLASSES': (
        'rest_framework.throttling.AnonRateThrottle',
        'core.throttling.BurstUserRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        'rest_framework.throttling.ScopedRateThrottle',
    ),
    'DEFAULT_THROTTLE_RATES': _throttle_rates(DEBUG),
    'EXCEPTION_HANDLER': 'core.exception_handler.api_exception_handler',
}

# JWTs are signed with RS256, not HS256.
#
# With a symmetric algorithm the frontend middleware would need the same secret
# Django signs with in order to verify a token — and anything that can verify
# can also forge. Asymmetric signing gives the frontend the PUBLIC key only, so
# a compromised frontend can check tokens but never mint them. The two secrets
# then have independent compromise domains.
def _load_pem(var_name):
    raw = os.getenv(var_name, '')
    if not raw:
        return None
    if 'BEGIN' in raw:          # PEM supplied directly
        return raw.replace('\\n', '\n')
    try:                        # base64-encoded PEM (single-line friendly)
        import base64
        return base64.b64decode(raw).decode()
    except Exception as exc:
        raise ImproperlyConfigured(f'{var_name} is not valid PEM or base64 PEM.') from exc


JWT_PRIVATE_KEY = _load_pem('JWT_PRIVATE_KEY_B64')
JWT_PUBLIC_KEY = _load_pem('JWT_PUBLIC_KEY_B64')

if JWT_PRIVATE_KEY and JWT_PUBLIC_KEY:
    _jwt_algorithm = 'RS256'
    _signing_key, _verifying_key = JWT_PRIVATE_KEY, JWT_PUBLIC_KEY
elif DEBUG:
    # Local fallback so the project still boots without a keypair.
    _jwt_algorithm, _signing_key, _verifying_key = 'HS256', SECRET_KEY, None
else:
    raise ImproperlyConfigured(
        'JWT_PRIVATE_KEY_B64 and JWT_PUBLIC_KEY_B64 are required when DEBUG is '
        'off. Generate a keypair with:\n'
        '  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 '
        '-out jwt_private.pem\n'
        '  openssl rsa -pubout -in jwt_private.pem -out jwt_public.pem\n'
        'then base64-encode each file into the matching variable.'
    )

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=int(os.getenv('ACCESS_TOKEN_MINUTES', '15'))),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=int(os.getenv('REFRESH_TOKEN_DAYS', '7'))),
    # Rotation + blacklist give us real logout and replay detection.
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN': True,
    'ALGORITHM': _jwt_algorithm,
    'SIGNING_KEY': _signing_key,
    'VERIFYING_KEY': _verifying_key,
    'AUTH_HEADER_TYPES': ('Bearer',),
}


# Real-time messaging (Django Channels / WebSockets) was removed at the owner's
# request. Redis is retained only as an optional cache backend below.
REDIS_URL = os.getenv('REDIS_URL')


# ------------------------------------------------------------------ database

# SQLITE CONNECTION TUNING.
#
# READ THIS BEFORE CONCLUDING THE CONCURRENCY PROBLEM IS SOLVED. IT IS NOT.
#
# `select_for_update()` IS A NO-OP ON THIS ENGINE. `connection.features.
# has_select_for_update` is False for SQLite, and Django responds by SILENTLY
# OMITTING the FOR UPDATE clause — no warning, no exception. So the row lock in
# `core.services.next_reference_number`, which exists solely to
# serialise reference-number allocation, locks nothing. Two simultaneous
# registrations still read the same maximum, compute the same next number, and
# the `uniq_registration_no_per_company` constraint turns the loser into an
# IntegrityError -> HTTP 500. NOTHING IN THIS BLOCK CHANGES THAT. The fix is
# Postgres (the branch below is ready for it); everything here only reduces how
# often unrelated writers trip over the database-level file lock.
#
# WHY `OPTIONS` AND NOT A `connection_created` RECEIVER. Django's SQLite
# backend runs `OPTIONS['init_command']` inside `get_new_connection()`, before
# the connection is handed to anyone (django/db/backends/sqlite3/base.py:196
# and :212 in Django 6.0). A `connection_created` receiver would also work, but
# it fires later, has to be imported to exist at all, and is one more thing to
# forget. OPTIONS is the narrower hook and cannot be bypassed.
#
#   journal_mode = WAL
#       Readers stop blocking the writer and vice versa; previously any read
#       overlapping a write could raise "database is locked". WAL is stored in
#       the database FILE, so it persists once set — which is also why it must
#       be verified rather than assumed. `SqliteConcurrencyMitigationTests` in
#       core/tests.py opens a real file with these OPTIONS and reads the pragma
#       back; the suite's own database is in-memory, where journal_mode always
#       answers 'memory' and an assertion would prove nothing.
#
#   timeout = 15  (seconds)
#       Passed straight to sqlite3.connect(), which calls sqlite3_busy_timeout.
#       A blocked writer now WAITS up to 15s for the lock instead of failing
#       instantly. 15s sits under the 30s gunicorn worker timeout, so a request
#       that loses the race still fails as a request rather than as a killed
#       worker.
#
#   transaction_mode = IMMEDIATE
#       Without this the busy timeout barely helps. SQLite's default DEFERRED
#       transaction takes a read lock first and UPGRADES to a write lock at the
#       first INSERT — and a failed upgrade returns SQLITE_BUSY IMMEDIATELY,
#       without consulting the busy handler, because the transaction's snapshot
#       is already stale and retrying could not succeed. Taking the write lock
#       up front is what makes the wait apply. The cost is real: every
#       `transaction.atomic` block now serialises against every other one,
#       read-only blocks included.
#
#   synchronous = NORMAL
#       WORTH IT HERE, and the reason is specific to WAL. In WAL mode NORMAL
#       cannot corrupt the database — SQLite's own durability documentation
#       says the only exposure is losing the most recent transactions after an
#       OS crash or power loss, not a damaged file. What we buy is the removal
#       of an fsync from every commit, which directly shortens the window a
#       writer holds the lock, which is the entire point of this block. The
#       trade would be wrong if SQLite were the intended long-term engine for
#       financial records; it is not (see the production guard below), so
#       trading a few seconds of crash-window durability for materially less
#       lock contention is the right call for a stopgap.
SQLITE_OPTIONS = {
    'timeout': int(os.getenv('SQLITE_BUSY_TIMEOUT_SECONDS', '15')),
    'transaction_mode': 'IMMEDIATE',
    'init_command': 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;',
}


def _guard_sqlite_engine(engine, debug, allow_sqlite):
    """
    Refuse to boot a non-DEBUG deployment on SQLite unless told to, explicitly.

    RAISE RATHER THAN WARN, matching SECRET_KEY / ALLOWED_HOSTS /
    CORS_ALLOWED_ORIGINS / FIELD_ENCRYPTION_KEY above. The argument for warning
    is that a warning cannot lock anyone out of a small single-user
    deployment — but a warning in this codebase would be printed once into
    gunicorn's error log and never read again, and the failure it predicts is
    not a startup failure. It is an intermittent HTTP 500 on registration
    creation under concurrent use, weeks later, that looks like an application
    bug and not like a database choice. Something that only misbehaves under
    load has to be refused at boot or it will not be caught at all.

    The escape hatch keeps the honest single-user case reachable, but requires
    someone to write ALLOW_SQLITE_IN_PRODUCTION=1 and thereby OWN the decision.
    Falling into SQLite because DATABASE_URL was never set is the outcome this
    exists to prevent.
    """
    if debug or allow_sqlite or not engine.endswith('sqlite3'):
        return
    raise ImproperlyConfigured(
        'SQLite is not a supported production engine for this application. '
        'Row locking does not exist on SQLite, so select_for_update() is '
        'silently ignored and concurrent registration creates collide on the '
        'per-company reference number. Set DATABASE_URL to a PostgreSQL '
        'connection string (or DB_ENGINE=django.db.backends.postgresql plus '
        'DB_NAME/DB_USER/DB_PASSWORD/DB_HOST). If this really is a '
        'single-user deployment and you accept the risk, set '
        'ALLOW_SQLITE_IN_PRODUCTION=1.'
    )


DATABASE_URL = os.getenv('DATABASE_URL')
if DATABASE_URL:
    DATABASES = {
        'default': dj_database_url.parse(
            DATABASE_URL, conn_max_age=600, conn_health_checks=True,
        )
    }
    # A sqlite:// DATABASE_URL reaches here too, and gets the same tuning.
    if DATABASES['default']['ENGINE'].endswith('sqlite3'):
        DATABASES['default'].setdefault('OPTIONS', {}).update(SQLITE_OPTIONS)
else:
    DB_ENGINE = os.getenv('DB_ENGINE', 'django.db.backends.sqlite3')
    if DB_ENGINE == 'django.db.backends.postgresql':
        DATABASES = {
            'default': {
                'ENGINE': DB_ENGINE,
                'NAME': os.getenv('DB_NAME', 'consultancy_db'),
                'USER': os.getenv('DB_USER', 'consultancy_user'),
                'PASSWORD': os.getenv('DB_PASSWORD', ''),
                'HOST': os.getenv('DB_HOST', 'localhost'),
                'PORT': os.getenv('DB_PORT', '5432'),
                # Parity with the DATABASE_URL branch above, which gets both of
                # these from dj_database_url(conn_max_age=600,
                # conn_health_checks=True). CONN_MAX_AGE without
                # CONN_HEALTH_CHECKS is the worse of the two configurations:
                # pooled connections are reused for 10 minutes and a link
                # dropped by the database, a proxy or a failover is discovered
                # by a query failing rather than by a cheap liveness probe, so
                # a restart on the database side surfaces as a burst of 500s.
                'CONN_MAX_AGE': 600,
                'CONN_HEALTH_CHECKS': True,
            }
        }
    else:
        DATABASES = {
            'default': {
                'ENGINE': 'django.db.backends.sqlite3',
                'NAME': BASE_DIR / 'db.sqlite3',
                # A copy, so DATABASES cannot alias the module-level template.
                'OPTIONS': dict(SQLITE_OPTIONS),
            }
        }

_guard_sqlite_engine(
    DATABASES['default']['ENGINE'], DEBUG, env_bool('ALLOW_SQLITE_IN_PRODUCTION', False),
)

# ATOMIC_REQUESTS IS DELIBERATELY OFF. Assessed, rejected — do not switch it on
# without re-reading this.
#
# 1. IT WOULD NOT DO WHAT IT LOOKS LIKE IT DOES HERE. ATOMIC_REQUESTS rolls
#    back when the VIEW RAISES. DRF catches APIException (and therefore every
#    ValidationError, PermissionDenied and Http404 this codebase raises) inside
#    `APIView.dispatch` and converts it into a Response, so the view returns
#    normally and the transaction COMMITS. A request that half-completed and
#    then returned 400 would be committed, not rolled back — the opposite of
#    the guarantee people assume they are buying. The ten explicit
#    `@transaction.atomic` decorators already in core/views.py (on
#    `perform_create`/`perform_update`/the approval and transfer actions) and
#    the three in core/services.py sit INSIDE DRF's try/except, so exceptions
#    do escape them and they do roll back correctly. They are the right
#    mechanism and they are already in place.
#
# 2. ON SQLITE IT WOULD BE ACTIVELY HARMFUL. Combined with
#    transaction_mode=IMMEDIATE above, wrapping every request in atomic() means
#    every request — every GET, every list, every dashboard poll — opens with
#    BEGIN IMMEDIATE and takes the database's single write lock. The API would
#    serialise completely.
#
# 3. IT WOULD HOLD A WRITE TRANSACTION ACROSS FILE I/O. `DocumentViewSet`
#    encrypts on upload and decrypts on download, touching PRIVATE_MEDIA_ROOT
#    inside the view. Under ATOMIC_REQUESTS that filesystem work happens with
#    the transaction open, lengthening lock hold times for no benefit.
#
# If it is ever revisited on Postgres, the prerequisite is a custom DRF
# exception handler that re-raises (or calls transaction.set_rollback(True))
# for 5xx and for the 4xx paths that write before failing. Until that exists,
# per-view atomic blocks are both safer and more honest.


# --------------------------------------------------------------------- cache

REDIS_CACHE_URL = os.getenv('REDIS_CACHE_URL', REDIS_URL)
if REDIS_CACHE_URL:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': REDIS_CACHE_URL,
            'TIMEOUT': 300,
        }
    }
else:
    # PER-PROCESS. Fine for a single dev server; NOT fine for the API throttles
    # in REST_FRAMEWORK above, whose counters live in this cache — each gunicorn
    # worker would keep its own tally and the effective limit becomes N times
    # what is configured. See the note in `_throttle_rates`.
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
            'LOCATION': 'consultancy-default',
            'TIMEOUT': 300,
        }
    }

# TTL for the per-caller response cache on the aggregate endpoints
# (core/caching.py; applied in core/analytics.py and to payments/stats).
#
# Short on purpose. These are dashboard counters, so the cost of the cache is
# that a user's own write does not move their own numbers until the entry
# expires — 30 seconds is under the threshold where that reads as "broken"
# while still collapsing the repeated polls a dashboard makes. Set to 0 to
# disable caching entirely without removing the decorators.
SCOPED_CACHE_SECONDS = int(os.getenv('SCOPED_CACHE_SECONDS', '30'))


# ------------------------------------------------------------------ passwords

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
     'OPTIONS': {'min_length': 10}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]


# ------------------------------------------------------------------ i18n/time

LANGUAGE_CODE = 'en-us'
TIME_ZONE = os.getenv('TIME_ZONE', 'UTC')
USE_I18N = True
USE_TZ = True


# ---------------------------------------------------------------- static/media

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

MEDIA_URL = '/media/'
MEDIA_ROOT = Path(os.getenv('MEDIA_ROOT', BASE_DIR / 'media'))

# Django 5.1+ removed STATICFILES_STORAGE in favour of STORAGES.
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'
        if not DEBUG else
        'django.contrib.staticfiles.storage.StaticFilesStorage'
    },
}

# Uploaded documents are never served by the web server directly; they are
# streamed through an authenticated view. Keep them out of any public root.
PRIVATE_MEDIA_ROOT = Path(os.getenv('PRIVATE_MEDIA_ROOT', BASE_DIR / 'private_media'))

DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024   # 10 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
MAX_DOCUMENT_SIZE_BYTES = int(os.getenv('MAX_DOCUMENT_SIZE_BYTES', 10 * 1024 * 1024))

ALLOWED_DOCUMENT_EXTENSIONS = env_list(
    'ALLOWED_DOCUMENT_EXTENSIONS',
    ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'doc', 'docx', 'xls', 'xlsx'],
)


# ---------------------------------------------------------------- encryption

# Fernet key used for application-level encryption of PII at rest and for
# document contents. Rotating it requires re-encrypting existing rows.
FIELD_ENCRYPTION_KEY = os.getenv('FIELD_ENCRYPTION_KEY')
if not FIELD_ENCRYPTION_KEY:
    if not DEBUG:
        raise ImproperlyConfigured(
            'FIELD_ENCRYPTION_KEY is required when DEBUG is off. Generate one '
            'with: python -c "from cryptography.fernet import Fernet; '
            'print(Fernet.generate_key().decode())"'
        )
    # Deterministic dev key so local data survives a restart. Development
    # only: it is committed, so anything encrypted with it is not protected.
    FIELD_ENCRYPTION_KEY = 'hJUrkAXmazKact8UXpITdVARsSouVIEjBlgpiTUVTU0='

DOCUMENT_URL_TTL_SECONDS = int(os.getenv('DOCUMENT_URL_TTL_SECONDS', '300'))


DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'


# ------------------------------------------------------------------ security

# Behind nginx/Render/Railway Django sees http; without this every secure
# cookie is issued but never returned, and admin logins fail CSRF.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
USE_X_FORWARDED_HOST = True

if not DEBUG:
    SECURE_SSL_REDIRECT = env_bool('SECURE_SSL_REDIRECT', True)
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = 'same-origin'
    X_FRAME_OPTIONS = 'DENY'
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'


# -------------------------------------------------------------------- logging

LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {name} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'verbose',
        },
    },
    'root': {'handlers': ['console'], 'level': LOG_LEVEL},
    'loggers': {
        'django.request': {'handlers': ['console'], 'level': 'ERROR', 'propagate': False},
        'core': {'handlers': ['console'], 'level': LOG_LEVEL, 'propagate': False},
        'core.security': {'handlers': ['console'], 'level': 'INFO', 'propagate': False},
    },
}
