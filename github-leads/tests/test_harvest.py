from leads import (
    SearchPage,
    code_children,
    code_qualifier,
    connect,
    exhaust_search,
    fragment_url_stats,
    get_slice,
)


def test_finished_search_makes_no_further_requests(tmp_path):
    conn = connect(tmp_path / "leads.db")
    calls: list[int] = []

    def fetch(_query: str, page: int) -> SearchPage:
        calls.append(page)
        return SearchPage(150, False, [{"page": page}])

    stored: list = []
    kwargs = dict(
        kind="code",
        query="adspower",
        fetch_page=fetch,
        children_for=lambda _slice, _total: [],
        qualifier_of=lambda _slice: "",
        store_items=lambda items, _slice: stored.extend(items),
    )
    exhaust_search(conn, **kwargs)
    assert calls == [1, 2]
    assert len(stored) == 2
    exhaust_search(conn, **kwargs)
    assert calls == [1, 2]
    conn.close()


def test_pending_slice_resumes_after_page_one(tmp_path):
    conn = connect(tmp_path / "leads.db")
    from leads import mark_page, set_slice

    set_slice(conn, "code", "adspower", "", "pending", 250)
    mark_page(conn, "code", "adspower", "", 1, False)
    conn.commit()
    calls: list[int] = []

    def fetch(_query: str, page: int) -> SearchPage:
        calls.append(page)
        return SearchPage(250, page == 2, [{"page": page}])

    exhaust_search(
        conn,
        kind="code",
        query="adspower",
        fetch_page=fetch,
        children_for=lambda _slice, _total: [],
        qualifier_of=lambda _slice: "",
        store_items=lambda _items, _slice: None,
    )
    assert calls == [2, 3]
    state = get_slice(conn, "code", "adspower", "")
    assert state["status"] == "complete"
    incomplete = conn.execute(
        "SELECT incomplete FROM query_progress WHERE page = 2"
    ).fetchone()
    assert incomplete["incomplete"] == 1
    conn.close()


def test_over_cap_bisects_and_a_rerun_makes_no_requests(tmp_path):
    conn = connect(tmp_path / "leads.db")
    calls: list[str] = []

    def total_for(query: str) -> int:
        if "size:0..192000" in query:
            return 10
        if "size:192001..384000" in query:
            return 10
        if "size:0..384000" in query:
            return 2_000
        return 2_000

    def fetch(query: str, page: int) -> SearchPage:
        assert page == 1
        calls.append(query)
        return SearchPage(total_for(query), False, [{"q": query}])

    kwargs = dict(
        kind="code",
        query="adspower",
        fetch_page=fetch,
        children_for=code_children,
        qualifier_of=code_qualifier,
        store_items=lambda _items, _slice: None,
    )
    exhaust_search(conn, **kwargs)
    assert calls == [
        "adspower",
        "adspower size:0..384000",
        "adspower size:0..192000",
        "adspower size:192001..384000",
    ]
    root = get_slice(conn, "code", "adspower", "")
    assert root["status"] == "split"
    assert root["total_count"] == 2_000
    assert get_slice(conn, "code", "adspower", "size:0..192000")["status"] == "complete"
    exhaust_search(conn, **kwargs)
    assert len(calls) == 4
    conn.close()


def test_rejected_query_is_not_retried(tmp_path):
    conn = connect(tmp_path / "leads.db")
    calls = {"n": 0}

    def fetch(_query: str, _page: int) -> SearchPage:
        calls["n"] += 1
        return SearchPage(0, False, [], rejected=True)

    kwargs = dict(
        kind="code",
        query="bad",
        fetch_page=fetch,
        children_for=code_children,
        qualifier_of=code_qualifier,
        store_items=lambda _items, _slice: None,
    )
    exhaust_search(conn, **kwargs)
    exhaust_search(conn, **kwargs)
    assert calls["n"] == 1
    assert get_slice(conn, "code", "bad", "")["status"] == "rejected"
    conn.close()


def test_fragment_report_keeps_api_hosts_and_drops_source_files():
    fragment = (
        'client.get("http://local.adspower.net:50325/status") '
        "see dolphin-anty-api.com and main.py "
        "https://github.com/acme/widget"
    )
    urls, hosts = fragment_url_stats([fragment, fragment])
    assert urls[0] == ("http://local.adspower.net:50325/status", 2)
    host_names = [host for host, _count in hosts]
    assert "local.adspower.net" in host_names
    assert "dolphin-anty-api.com" in host_names
    assert "github.com" not in host_names
    assert all(not name.endswith(".py") for name in host_names)
