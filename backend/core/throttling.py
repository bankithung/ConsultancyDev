"""
Custom throttle classes.

`UserRateThrottle` reads exactly ONE scope, so covering two windows needs two
classes. See `_throttle_rates` in config/settings.py for why this app needs a
short window as well as an hourly one.
"""

from rest_framework.throttling import UserRateThrottle


class BurstUserRateThrottle(UserRateThrottle):
    """
    Short-window ceiling on a single user's requests.

    Runs ALONGSIDE `UserRateThrottle`, not instead of it: DRF applies every
    class in DEFAULT_THROTTLE_CLASSES and the first to refuse wins. This one
    catches a client that has gone into a loop within seconds; the hourly
    `user` scope catches sustained load that stays under this ceiling.

    The distinct `scope` is load-bearing. `SimpleRateThrottle` builds its cache
    key from `scope`, so reusing 'user' here would leave both classes reading
    and incrementing the SAME counter — the tighter of the two rates would then
    silently apply everywhere and the second bucket would do nothing.
    """

    scope = 'user_burst'
