from leads import apply_exclusion_filters, connect, is_wrapper_repo, upsert_repo


def test_wrapper_match_requires_adspower_or_dolphin_anty():
    assert is_wrapper_repo("AdsPower/adspower-sdk", "browser api")
    assert is_wrapper_repo("someone/dolphin-anty-client", "")
    assert not is_wrapper_repo("dolphin-emu/dolphin", "GameCube and Wii emulator")
    assert not is_wrapper_repo("Kaliiiiiiiiii-Vinyzu/patchright", "patched playwright")


def test_broad_hits_and_non_wrapper_forks_are_excluded(tmp_path, capsys):
    conn = connect(tmp_path / "leads.db")
    conn.executemany(
        """
        INSERT INTO hits (query, slice, repo_full_name, path, fragment, fetched_at)
        VALUES (?, '', ?, ?, ?, '2026-01-01T00:00:00Z')
        """,
        [
            ("dolphin anty selenium", "emu/dolphin", "src/emu.c", "dolphin emulator"),
            ("dolphin anty playwright", "acme/bot", "src/bot.py", "https://dolphin-anty-api.com"),
            ("dolphin anty selenium || \"local.adspower.net\"", "acme/real", "run.py", "local.adspower.net:50325"),
            ('"local.adspower.net"', "acme/direct", "main.py", "no marker in this fragment"),
        ],
    )
    upsert_repo(
        conn,
        full_name="Kaliiiiiiiiii-Vinyzu/patchright",
        source="repo",
        is_fork=0,
        description="patched playwright",
        owner_login="Kaliiiiiiiiii-Vinyzu",
        fetched_at="2026-01-01T00:00:00Z",
    )
    upsert_repo(
        conn,
        full_name="someone/patchright-fork",
        source="fork",
        is_fork=1,
        forked_from="Kaliiiiiiiiii-Vinyzu/patchright",
        owner_login="someone",
        fetched_at="2026-01-01T00:00:00Z",
    )
    upsert_repo(
        conn,
        full_name="AdsPower/adspower-sdk",
        source="repo",
        is_fork=0,
        description="official sdk",
        owner_login="AdsPower",
        fetched_at="2026-01-01T00:00:00Z",
    )
    upsert_repo(
        conn,
        full_name="user/adspower-fork",
        source="fork",
        is_fork=1,
        forked_from="AdsPower/adspower-sdk",
        owner_login="user",
        fetched_at="2026-01-01T00:00:00Z",
    )
    conn.commit()

    apply_exclusion_filters(conn)
    output = capsys.readouterr().out
    assert "Hits before filter: 4" in output
    assert "Hits after filter: 3" in output
    assert "Repos before filter: 4" in output
    assert "Repos after filter: 3" in output
    assert "Accounts before filter: 4" in output
    assert "Accounts after filter: 3" in output

    noise = conn.execute("SELECT excluded, exclude_reason FROM hits WHERE path = 'src/emu.c'").fetchone()
    assert noise["excluded"] == 1
    assert noise["exclude_reason"] == "broad_query_noise"
    kept = conn.execute(
        "SELECT excluded FROM hits WHERE repo_full_name IN ('acme/bot', 'acme/real', 'acme/direct')"
    ).fetchall()
    assert [row["excluded"] for row in kept] == [0, 0, 0]
    fork = conn.execute("SELECT excluded, exclude_reason FROM repos WHERE full_name = 'someone/patchright-fork'").fetchone()
    assert fork["excluded"] == 1
    assert fork["exclude_reason"] == "not_a_wrapper"
    real_fork = conn.execute("SELECT excluded FROM repos WHERE full_name = 'user/adspower-fork'").fetchone()
    assert real_fork["excluded"] == 0
    conn.close()
