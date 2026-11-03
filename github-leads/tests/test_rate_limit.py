import httpx

from leads import (
    INCOMPLETE_RETRY_SECONDS,
    INITIAL_BACKOFF,
    RateLimiter,
    SearchPage,
    is_rate_limited,
    send_with_backoff,
    with_incomplete_retry,
)


class Clock:
    def __init__(self, start: float = 0):
        self.t = start
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


def limiter(min_interval: float = 0, start: float = 0) -> tuple[RateLimiter, Clock]:
    clock = Clock(start)
    return RateLimiter(min_interval, sleep=clock.sleep, clock=clock.now), clock


def response(status: int, headers: dict | None = None, body: bytes = b"") -> httpx.Response:
    return httpx.Response(
        status,
        headers=headers,
        content=body,
        request=httpx.Request("GET", "https://api.github.com/x"),
    )


def test_first_request_does_not_sleep():
    pace, clock = limiter(6.5)
    pace.wait()
    assert clock.sleeps == []


def test_min_interval_paces_the_next_request():
    pace, clock = limiter(6.5)
    pace.wait()
    pace.wait()
    assert clock.sleeps == [6.5]


def test_remaining_zero_sleeps_until_reset():
    pace, clock = limiter(0, start=1_000)
    pace.remaining = 0
    pace.reset_at = 1_030
    pace.wait()
    assert clock.sleeps == [31]
    assert pace.remaining is None


def test_successful_response_with_remaining_zero_delays_the_next_wait():
    pace, clock = limiter(0, start=10)

    def do():
        return response(200, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "50"})

    send_with_backoff(do, pace)
    assert clock.sleeps == []
    pace.wait()
    assert clock.sleeps == [41]


def test_retry_after_sleeps_once():
    pace, clock = limiter(0)
    replies = [
        response(429, {"Retry-After": "2"}),
        response(200, {"X-RateLimit-Remaining": "9", "X-RateLimit-Reset": "0"}),
    ]

    def do():
        return replies.pop(0)

    result = send_with_backoff(do, pace)
    assert result.status_code == 200
    assert clock.sleeps == [2]


def test_retry_after_uses_mock_transport():
    pace, clock = limiter(0)
    replies = [
        response(429, {"Retry-After": "5"}),
        response(200, {"X-RateLimit-Remaining": "8"}),
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return replies.pop(0)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = send_with_backoff(lambda: client.get("https://api.github.com/rate_limit"), pace)
    assert result.status_code == 200
    assert clock.sleeps == [5]


def test_backoff_starts_at_60_and_doubles_without_retry_after():
    pace, clock = limiter(0)
    replies = [response(429), response(403, {"X-RateLimit-Remaining": "0"}), response(200)]

    def do():
        return replies.pop(0)

    result = send_with_backoff(do, pace)
    assert result.status_code == 200
    assert clock.sleeps == [INITIAL_BACKOFF, INITIAL_BACKOFF * 2]


def test_forbidden_that_is_not_a_rate_limit_is_returned():
    pace, clock = limiter(0)
    calls = {"n": 0}

    def do():
        calls["n"] += 1
        return response(403, {"X-RateLimit-Remaining": "10"}, b'{"message":"Resource not accessible"}')

    result = send_with_backoff(do, pace)
    assert result.status_code == 403
    assert calls["n"] == 1
    assert clock.sleeps == []
    assert is_rate_limited(result) is False


def test_transport_error_uses_backoff_then_succeeds():
    pace, clock = limiter(0)
    calls = {"n": 0}

    def do():
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("connection refused")
        return response(200)

    result = send_with_backoff(do, pace)
    assert result.status_code == 200
    assert clock.sleeps == [INITIAL_BACKOFF]


def test_server_error_retries():
    pace, clock = limiter(0)
    replies = [response(502), response(200)]

    def do():
        return replies.pop(0)

    assert send_with_backoff(do, pace).status_code == 200
    assert clock.sleeps == [INITIAL_BACKOFF]


def test_incomplete_results_retry_once():
    calls = {"n": 0}
    penalties: list[float] = []

    def fetch():
        calls["n"] += 1
        if calls["n"] == 1:
            return SearchPage(10, True, [{"id": 1}])
        return SearchPage(10, False, [{"id": 2}])

    page = with_incomplete_retry(fetch, penalties.append, log_fn=lambda _msg: None)
    assert calls["n"] == 2
    assert penalties == [INCOMPLETE_RETRY_SECONDS]
    assert page.items == [{"id": 2}]
    assert page.incomplete is False


def test_incomplete_results_kept_when_the_retry_is_still_incomplete():
    logs: list[str] = []

    def fetch():
        return SearchPage(10, True, [{"id": 1}])

    page = with_incomplete_retry(fetch, lambda _delay: None, log_fn=logs.append)
    assert page.incomplete is True
    assert len(logs) == 2
