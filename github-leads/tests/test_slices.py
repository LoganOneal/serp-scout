from datetime import date

import pytest

from leads import (
    INDEXED_MAX_BYTES,
    LANGUAGES,
    SEARCH_CAP,
    SizeSlice,
    bisect_size,
    child_created_slices,
    child_size_slices,
    github_size_qualifier,
    page_count,
    parse_size_slice,
)


def test_bisect_matches_the_indexed_file_cap():
    assert bisect_size(0, 384_000) == ((0, 192_000), (192_001, 384_000))


def test_bisect_covers_the_range_without_a_gap_or_overlap():
    (low_a, high_a), (low_b, high_b) = bisect_size(0, INDEXED_MAX_BYTES)
    assert low_a == 0
    assert high_b == INDEXED_MAX_BYTES
    assert high_a + 1 == low_b


def test_bisect_odd_width_and_point_range():
    assert bisect_size(0, 5) == ((0, 2), (3, 5))
    assert bisect_size(10, 10) is None
    assert bisect_size(4, 3) is None


def test_under_or_at_cap_is_not_split():
    assert child_size_slices(SizeSlice(), SEARCH_CAP) == []
    assert child_size_slices(SizeSlice(0, 100), 1) == []


def test_over_cap_starts_at_the_indexed_size_window():
    assert child_size_slices(SizeSlice(), SEARCH_CAP + 1) == [SizeSlice(0, INDEXED_MAX_BYTES)]


def test_size_window_bisects_before_languages():
    children = child_size_slices(SizeSlice(0, INDEXED_MAX_BYTES), 5_000)
    assert children == [
        SizeSlice(0, 192_000),
        SizeSlice(192_001, INDEXED_MAX_BYTES),
    ]
    # A two-byte range still bisects; language is only for a single byte.
    assert child_size_slices(SizeSlice(1, 2), 5_000) == [
        SizeSlice(1, 1),
        SizeSlice(2, 2),
    ]


def test_single_byte_over_cap_splits_by_language():
    children = child_size_slices(SizeSlice(42, 42), 5_000)
    assert [child.language for child in children] == LANGUAGES
    assert all(child.low == 42 and child.high == 42 for child in children)


def test_language_slice_that_is_still_over_cap_stops():
    assert child_size_slices(SizeSlice(42, 42, "Python"), 5_000) == []


def test_size_slice_keys_round_trip_and_github_qualifiers():
    assert parse_size_slice("") == SizeSlice()
    assert github_size_qualifier(SizeSlice()) == ""
    python = SizeSlice(1, 2, "Python")
    assert python.key() == "size:1..2 lang:Python"
    assert parse_size_slice(python.key()) == python
    assert github_size_qualifier(python) == "size:1..2 language:Python"
    other = github_size_qualifier(SizeSlice(1, 1, "Other"))
    assert other.startswith("size:1..1 ")
    assert "-language:Python" in other
    assert '-language:"C#"' in other
    assert parse_size_slice("size:8..8 lang:C#") == SizeSlice(8, 8, "C#")


def test_bad_size_slice_is_rejected():
    with pytest.raises(ValueError):
        parse_size_slice("language:Python")


def test_page_count_respects_the_thousand_cap():
    assert page_count(0) == 0
    assert page_count(1) == 1
    assert page_count(100) == 1
    assert page_count(101) == 2
    assert page_count(1000) == 10
    assert page_count(1001) == 10


def test_created_slices_go_year_then_month_then_day():
    today = date(2026, 10, 16)
    assert child_created_slices("", SEARCH_CAP, today) == []
    years = child_created_slices("", 5_000, today)
    assert years[0] == "created:2008-01-01..2008-12-31"
    assert years[-1] == "created:2026-01-01..2026-10-16"
    assert len(years) == 19
    assert child_created_slices(years[0], 10, today) == []

    months = child_created_slices("created:2020-01-01..2020-12-31", 2_000, today)
    assert months[0] == "created:2020-01-01..2020-01-31"
    assert months[-1] == "created:2020-12-01..2020-12-31"
    assert len(months) == 12

    # January is a month, not a year, even though it starts on Jan 1.
    january = child_created_slices("created:2020-01-01..2020-01-31", 5_000, today)
    assert len(january) == 31
    assert january[0] == "created:2020-01-01..2020-01-01"

    february = child_created_slices("created:2020-02-01..2020-02-29", 2_000, today)
    assert len(february) == 29
    assert february[-1] == "created:2020-02-29..2020-02-29"
    assert child_created_slices(february[-1], 5_000, today) == []

    current = child_created_slices("created:2026-01-01..2026-10-16", 5_000, today)
    assert len(current) == 10
    assert current[-1] == "created:2026-10-01..2026-10-16"


def test_a_year_that_is_only_january_splits_into_days():
    today = date(2026, 1, 16)
    years = child_created_slices("", 5_000, today)
    assert years[-1] == "created:2026-01-01..2026-01-16"
    days = child_created_slices(years[-1], 5_000, today)
    assert len(days) == 16
    assert days[-1] == "created:2026-01-16..2026-01-16"
