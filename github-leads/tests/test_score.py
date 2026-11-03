import csv
import json
from datetime import datetime, timedelta, timezone

import pytest

from leads import (
    ScoredRepo,
    classify_tool,
    connect,
    export_run,
    is_tutorial,
    is_vendor,
    region_hint,
    score_account,
    score_run,
    segment_labels,
    tools_from_text,
    upsert_repo,
)

NOW = datetime(2026, 10, 16, tzinfo=timezone.utc)


def repo(name: str, hits: int = 1, pushed: datetime | None = None, created: datetime | None = None, description: str = "") -> ScoredRepo:
    return ScoredRepo(
        full_name=f"acme/{name}",
        name=name,
        description=description,
        pushed_at=NOW if pushed is None else pushed,
        created_at=created or datetime(2024, 1, 1, tzinfo=timezone.utc),
        hit_files=hits,
    )


def test_score_adds_org_contact_recency_breadth_twitter_and_followers():
    parts = score_account(
        owner_type="Organization",
        company="Acme",
        blog="",
        twitter="acme",
        followers=25,
        account_created=datetime(2019, 1, 1, tzinfo=timezone.utc),
        login="acme",
        repos=[repo("one", hits=3), repo("two")],
        now=NOW,
    )
    # org 3 + contact 2 + recent 2 + one extra repo + twitter + followers
    assert parts.total == 10
    assert parts.components["extra_repos"] == 1
    assert parts.excluded is False


def test_extra_repo_points_cap_at_three():
    parts = score_account(
        owner_type="User",
        company="",
        blog="",
        twitter="",
        followers=0,
        account_created=datetime(2019, 1, 1, tzinfo=timezone.utc),
        login="acme",
        repos=[repo(f"r{i}", pushed=datetime(2020, 1, 1, tzinfo=timezone.utc)) for i in range(5)],
        now=NOW,
    )
    assert parts.components["extra_repos"] == 3
    assert parts.components["recent_push"] == 0


def test_throwaway_penalty_only_when_the_account_is_just_older_than_its_only_repo():
    created = datetime(2026, 9, 1, tzinfo=timezone.utc)
    only = repo("only", hits=2, pushed=datetime(2020, 1, 1, tzinfo=timezone.utc), created=datetime(2026, 9, 10, tzinfo=timezone.utc))
    parts = score_account(
        owner_type="User",
        company="",
        blog="",
        twitter="",
        followers=0,
        account_created=created,
        login="acme",
        repos=[only],
        now=NOW,
    )
    assert parts.components["throwaway"] == -2
    assert parts.total == -2

    older_repo = repo("only", hits=2, pushed=datetime(2020, 1, 1, tzinfo=timezone.utc), created=created - timedelta(days=10))
    kept = score_account(
        owner_type="User",
        company="",
        blog="",
        twitter="",
        followers=0,
        account_created=created,
        login="acme",
        repos=[older_repo],
        now=NOW,
    )
    assert kept.components["throwaway"] == 0


def test_vendor_login_is_flagged_and_not_deleted_from_the_score():
    assert is_vendor("AdsPowerHQ")
    assert is_vendor("my-dolphin-bot")
    assert not is_vendor("acme")
    parts = score_account(
        owner_type="Organization",
        company="AdsPower",
        blog="https://adspower.com",
        twitter="ads",
        followers=100,
        account_created=datetime(2018, 1, 1, tzinfo=timezone.utc),
        login="AdsPowerHQ",
        repos=[repo("sdk")],
        now=NOW,
    )
    assert parts.excluded is True
    assert parts.exclude_reason == "vendor"
    assert parts.total > 0


def test_tutorial_flag_needs_the_name_and_a_single_matching_file():
    assert is_tutorial([repo("awesome-adspower", hits=1, description="docs")])
    assert is_tutorial([repo("demo", hits=0, description="example")])
    assert not is_tutorial([repo("awesome-adspower", hits=2)])
    assert not is_tutorial([repo("production-bot", hits=1, description="runs accounts")])
    assert not is_tutorial([
        repo("awesome-adspower", hits=1),
        repo("production-bot", hits=0, description="runs accounts"),
    ])
    parts = score_account(
        owner_type="User",
        company="",
        blog="",
        twitter="",
        followers=0,
        account_created=datetime(2020, 1, 1, tzinfo=timezone.utc),
        login="student",
        repos=[repo("adspower-demo", hits=1, description="tutorial")],
        now=NOW,
    )
    assert parts.exclude_reason == "tutorial"


def test_segments_region_and_tool_labels():
    text = "We warm facebook ads accounts and run shopify arbitrage"
    labels = segment_labels(text)
    assert "facebook_ads" in labels
    assert "shopify" in labels
    assert "arbitrage" in labels
    assert "social_warmup" in labels
    assert region_hint("Moscow", "hello") == "cis"
    assert region_hint("", "Привет") == "cyrillic"
    assert region_hint("Hanoi", "xin chào") == "vietnam"
    assert region_hint("", "自动化") == "cjk"
    assert tools_from_text("the dolphin swims") == set()
    assert tools_from_text("dolphin-anty") == {"dolphin"}
    assert classify_tool('"local.adspower.net" || "dolphin-anty-api.com"', []) == "both"
    assert classify_tool("topic:antidetect", ["uses adspower"]) == "adspower"
    assert classify_tool("topic:antidetect", []) == "unknown"


class _Response:
    def __init__(self, status: int, text: str = ""):
        self.status_code = status
        self.text = text


class _Client:
    def __init__(self):
        self.calls = 0
        self.paths: list[str] = []

    def core_get(self, path: str, params=None, accept=None):
        self.calls += 1
        self.paths.append(path)
        return _Response(200, "facebook ads for shopify stores")


def _seed(conn) -> None:
    conn.execute(
        """
        INSERT INTO accounts (login, type, name, company, blog, location, twitter_username, bio, followers, created_at, fetched_at)
        VALUES ('acme', 'Organization', 'Acme', 'Acme', '', 'Moscow', 'acme', '', 40, '2019-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        """
    )
    conn.execute(
        """
        INSERT INTO accounts (login, type, name, company, blog, location, twitter_username, bio, followers, created_at, fetched_at)
        VALUES ('AdsPower', 'Organization', 'AdsPower', 'AdsPower', 'https://adspower.com', '', '', '', 100, '2018-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        """
    )
    upsert_repo(
        conn,
        full_name="acme/bot",
        source="code",
        is_fork=0,
        stars=4,
        pushed_at="2026-09-01T00:00:00Z",
        created_at="2024-01-01T00:00:00Z",
        description="account runner",
        owner_login="acme",
        owner_type="Organization",
        html_url="https://github.com/acme/bot",
        discovery_queries='"local.adspower.net"',
        fetched_at="2026-01-01T00:00:00Z",
    )
    upsert_repo(
        conn,
        full_name="AdsPower/sdk",
        source="repo",
        is_fork=0,
        stars=50,
        pushed_at="2026-09-01T00:00:00Z",
        created_at="2020-01-01T00:00:00Z",
        description="official sdk",
        owner_login="AdsPower",
        owner_type="Organization",
        html_url="https://github.com/AdsPower/sdk",
        discovery_queries="adspower",
        fetched_at="2026-01-01T00:00:00Z",
    )
    conn.execute(
        """
        INSERT INTO hits (query, slice, repo_full_name, path, sha, html_url, fragment, fetched_at)
        VALUES ('"local.adspower.net"', '', 'acme/bot', 'bot.py', 'abc', 'https://github.com/acme/bot/blob/main/bot.py', 'local.adspower.net', '2026-01-01T00:00:00Z')
        """
    )
    conn.commit()


def test_readme_is_fetched_once_and_only_for_strong_non_excluded_accounts(tmp_path):
    conn = connect(tmp_path / "leads.db")
    _seed(conn)
    client = _Client()
    score_run(conn, client, now=NOW)
    assert client.paths == ["/repos/acme/bot/readme"]
    row = conn.execute("SELECT score, segments, region, tool, excluded, exclude_reason FROM scores WHERE login = 'acme'").fetchone()
    assert row["score"] >= 4
    assert row["excluded"] == 0
    assert "facebook_ads" in json.loads(row["segments"])
    assert "shopify" in json.loads(row["segments"])
    assert row["region"] == "cis"
    assert row["tool"] == "adspower"
    vendor = conn.execute("SELECT excluded, exclude_reason FROM scores WHERE login = 'AdsPower'").fetchone()
    assert vendor["excluded"] == 1
    assert vendor["exclude_reason"] == "vendor"

    again = _Client()
    score_run(conn, again, now=NOW)
    assert again.calls == 0
    conn.close()


def test_export_sorts_by_score_and_refuses_to_run_before_scoring(tmp_path, monkeypatch, capsys):
    conn = connect(tmp_path / "leads.db")
    _seed(conn)
    with pytest.raises(SystemExit):
        export_run(conn)
    score_run(conn, _Client(), now=NOW)
    monkeypatch.setattr("leads.LEADS_CSV", tmp_path / "leads.csv")
    monkeypatch.setattr("leads.REPOS_CSV", tmp_path / "repos.csv")
    export_run(conn)
    with (tmp_path / "leads.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    scores = [int(row["score"]) for row in rows]
    assert scores == sorted(scores, reverse=True)
    acme = next(row for row in rows if row["login"] == "acme")
    assert acme["top_repos"] == "https://github.com/acme/bot"
    assert acme["tool"] == "adspower"
    assert acme["excluded"] == "0"
    summary = capsys.readouterr().out
    assert "Hits: 1" in summary
    assert "Excluded vendor: 1" in summary
    conn.close()
