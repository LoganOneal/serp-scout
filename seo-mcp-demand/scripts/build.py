"""Build all study tables, workbook and report without network access."""

import csv
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from fit import build_fit
from public import generate_public, records
from scoring import group_keywords, number, score_tasks, sensitivity, trend_growth
from study import ROOT, TASKS, generate, write_csv

KEYWORD_FIELDS = ["keyword", "task_ids", "seed_keyword", "volume_us", "volume_recent_3m", "brand_vendor", "volume_scored", "volume_basis", "volume_global", "traffic_potential", "cpc", "keyword_difficulty", "clicks_per_search", "trend_12m", "trend_growth_12m", "trend_24m", "parent_topic", "source", "source_url", "fetched_at", "status"]
PAGE_FIELDS = ["task_id", "url", "serp_query", "serp_position", "verified_free_tool", "organic_traffic_us", "traffic_24m", "traffic_months", "source", "source_url", "fetched_at", "status"]


def read_csv(path):
    with Path(path).open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def imported(name):
    path = ROOT / "imports" / name
    if not path.exists():
        return []
    content = path.read_bytes()
    archive = ROOT / "cache" / ("import-" + hashlib.sha256(content).hexdigest() + ".csv")
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        archive.write_bytes(content)
    return read_csv(archive)


def keywords():
    from prepare import semrush_rows

    seeds = read_csv(ROOT / "data/seeds.csv")
    mappings = defaultdict(set)
    for seed in seeds:
        mappings[seed["seed_keyword"]].add(seed["task_id"])
    observed = {}
    cached_keywords, candidates, cached_pages = semrush_rows()
    supplied = imported("keywords.csv")
    supplied_names = {row["keyword"].strip().lower() for row in supplied}
    for row in [row for row in cached_keywords if row["keyword"] not in supplied_names] + supplied:
        keyword = row["keyword"].strip().lower()
        task_ids = set(filter(None, row.get("task_ids", "").split("|"))) or mappings.get(row.get("seed_keyword", keyword), set())
        if not task_ids or not task_ids.issubset({task[1] for task in TASKS}):
            raise ValueError(f"Keyword {keyword!r} has no valid task mapping")
        if keyword in observed:
            raise ValueError(f"Duplicate keyword {keyword!r}; merge US/global metrics into one import row")
        if not row.get("source") or not row.get("fetched_at"):
            raise ValueError("Every observed keyword requires source and fetched_at")
        result = {field: row.get(field, "") for field in KEYWORD_FIELDS}
        result.update(keyword=keyword, task_ids="|".join(sorted(task_ids)), status="observed")
        for field in ("volume_us", "volume_recent_3m", "volume_scored", "volume_global", "traffic_potential", "cpc", "keyword_difficulty", "clicks_per_search"):
            number(result[field])
        if result["trend_24m"]:
            series = json.loads(result["trend_24m"])
            if not isinstance(series, list) or len(series) != 24:
                raise ValueError("trend_24m must be a chronological JSON list of exactly 24 monthly volumes")
            for value in series:
                number(value)
        observed[keyword] = result
    excluded_seeds = {row["keyword"] for row in read_csv(ROOT / "data/keywords_excluded.csv") if row["reason"] != "no task term match"}
    for keyword, task_ids in mappings.items():
        if keyword in excluded_seeds:
            continue
        if keyword not in observed and not any(keyword == row.get("seed_keyword") for row in observed.values()):
            observed[keyword] = {field: "" for field in KEYWORD_FIELDS}
            observed[keyword].update(keyword=keyword, task_ids="|".join(sorted(task_ids)), seed_keyword=keyword, status="not_collected")
    rows = sorted(observed.values(), key=lambda row: row["keyword"])
    write_csv("keywords_raw.csv", KEYWORD_FIELDS, rows)
    grouped = group_keywords(rows)
    write_csv("keywords_grouped.csv", ["task_id", "parent_topic", "keywords", "keyword_count", "allocation", "volume_us", "volume_scored", "volume_global", "traffic_potential", "rollup_method"], grouped)
    return rows, grouped


def pages():
    from prepare import semrush_rows

    cached_keywords, candidates, cached_pages = semrush_rows()
    supplied = imported("toolpages.csv")
    supplied_keys = {(row["task_id"], row["url"]) for row in supplied}
    observed = [row for row in cached_pages if (row["task_id"], row["url"]) not in supplied_keys] + supplied
    for row in observed:
        if row.get("task_id") not in {task[1] for task in TASKS}:
            raise ValueError("Tool page has an invalid task ID")
        if not row.get("url") or not row.get("serp_query") or number(row.get("serp_position")) is None or number(row.get("serp_position")) < 1:
            raise ValueError("Tool pages must be discovered from a recorded SERP query and position")
        if not row.get("source") or not row.get("fetched_at"):
            raise ValueError("Tool page metrics require source and fetched_at")
        number(row.get("organic_traffic_us"))
        row["status"] = "observed" if row.get("verified_free_tool") == "1" else "requires_free_tool_review"
    present = {row["task_id"] for row in observed}
    observed = [{field: row.get(field, "") for field in PAGE_FIELDS} for row in observed]
    for task in TASKS:
        if task[1] not in present:
            observed.append({**dict.fromkeys(PAGE_FIELDS, ""), "task_id": task[1], "status": "no_free_tool_selected" if (ROOT / "imports/toolpage_reviews.csv").exists() else "not_reviewed"})
    write_csv("toolpages.csv", PAGE_FIELDS, observed)
    return observed


def canonical_url(value):
    parts = urlsplit(value)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", parts.query, ""))


def page_traffic(rows):
    by_url = defaultdict(list)
    for row in rows:
        if row.get("verified_free_tool") == "1" and row.get("url") and number(row.get("organic_traffic_us")) is not None:
            by_url[canonical_url(row["url"])].append(row)
    allocated = defaultdict(float)
    for members in by_url.values():
        tasks = {row["task_id"] for row in members}
        value = max(number(row["organic_traffic_us"]) for row in members)
        for task_id in tasks:
            allocated[task_id] += value / len(tasks)
    return allocated


def mcp_usage(signals, metric):
    """log1p(useCount) per server, split across its tasks; no server may exceed 50% of a task's uncapped signal."""
    contributions = defaultdict(list)
    for row in signals:
        if row.get("usage_metric") != metric or number(row.get("usage_count")) is None:
            continue
        tasks = set(filter(None, row["task_ids"].split("|")))
        for task_id in tasks:
            contributions[task_id].append((math.log1p(number(row["usage_count"])) / len(tasks), row["name"]))
    usage, raw, top = {}, {}, {}
    for task_id, values in contributions.items():
        total = sum(value for value, _ in values)
        cap = 0.5 * total
        usage[task_id] = sum(min(value, cap) for value, _ in values)
        raw[task_id] = total
        best = max(values)
        top[task_id] = f"{best[1]} ({best[0] / total:.0%} before cap)" if total else ""
    return usage, raw, top


def build_scores(raw, grouped, toolpages, signals, fit, config):
    usage, usage_uncapped, usage_top = mcp_usage(signals, config["mcp_usage_metric"])
    traffic = page_traffic(toolpages)
    first_party = imported("first_party.csv")
    first_party_calls = {row["task_id"]: number(row["calls"]) for row in first_party}
    if first_party and set(first_party_calls) != {task[1] for task in TASKS}:
        raise ValueError("First-party call distribution must explicitly cover every task, including observed zero counts")
    weights = config["first_party_weights"] if first_party else config["weights"]
    by_fit = {row["task_id"]: row for row in fit}
    reviewed = (ROOT / "imports/toolpage_reviews.csv").exists()
    output = []
    for cluster, task_id, task, subject, notes in TASKS:
        selected = [row for row in raw if task_id in row["task_ids"].split("|")]
        measured = [row for row in selected if row["status"] == "observed"]
        parented = [row for row in measured if row["parent_topic"] and number(row.get(config["keyword_market_for_score"])) is not None]
        groups = [row for row in grouped if row["task_id"] == task_id]
        complete_keywords = bool(selected) and len(parented) == len(selected)
        # Volume-weighted 12-month keyword trend; Semrush keyword reports only give 12 months.
        weighted = [(number(row[config["keyword_market_for_score"]]) or 0, float(row["trend_growth_12m"])) for row in measured if row.get("trend_growth_12m") not in (None, "")]
        total_weight = sum(volume for volume, _ in weighted)
        keyword_trend = sum(volume * growth for volume, growth in weighted) / total_weight if total_weight else None
        task_pages = [row for row in toolpages if row["task_id"] == task_id and row.get("verified_free_tool") == "1" and row["url"]]
        pages_measured = all(number(row.get("organic_traffic_us")) is not None for row in task_pages)
        monthly = defaultdict(float)
        for row in task_pages:
            series = json.loads(row["traffic_24m"]) if row.get("traffic_24m") else []
            if len(series) == 24:
                for index, value in enumerate(series):
                    monthly[index] += value
        page_trend = trend_growth([monthly[index] for index in range(24)]) if len(monthly) == 24 else None
        result = {
            "cluster": cluster, "task_id": task_id, "task": task,
            "tool_page_traffic": traffic.get(task_id, 0.0) if reviewed and pages_measured else None,
            "keyword_volume_rollup": sum(row[config["keyword_market_for_score"]] or 0 for row in groups) if complete_keywords else None,
            "mcp_usage_signal": usage.get(task_id, 0.0),
            "mcp_usage_uncapped": usage_uncapped.get(task_id, 0.0),
            "mcp_top_server": usage_top.get(task_id, ""),
            "trend_growth": max(0.0, keyword_trend) if keyword_trend is not None else (0.0 if complete_keywords else None),
            "trend_growth_signed": keyword_trend,
            "tool_page_trend_24m": page_trend,
            "first_party_calls": first_party_calls.get(task_id),
            "measured_keywords": len(measured), "expected_keywords": len(selected), "keyword_topics": len(groups),
            "measured_tool_pages": len({canonical_url(row["url"]) for row in task_pages}),
            "top_tool_pages": " | ".join(row["url"] for row in sorted(task_pages, key=lambda row: -(number(row.get("organic_traffic_us")) or 0))[:3]),
            "top_keywords": " | ".join(f"{row['keyword']} ({int(number(row[config['keyword_market_for_score']]) or 0):,})" for row in sorted(measured, key=lambda row: -(number(row[config["keyword_market_for_score"]]) or 0))[:3]),
            "mapped_mcp_listings": sum(task_id in row["task_ids"].split("|") for row in signals),
            **{dimension: by_fit[task_id][dimension] for dimension in config["fit_dimensions"]},
        }
        output.append(result)
    scored = score_tasks(output, weights, config["fit_dimensions"])
    ranked = sorted([row for row in scored if row["score"] is not None], key=lambda row: (-row["score"], row["task_id"]))
    ranks = {row["task_id"]: index + 1 for index, row in enumerate(ranked)}
    for row in scored:
        row["rank"] = ranks.get(row["task_id"])
    scored.sort(key=lambda row: (row["rank"] is None, row["rank"] or 0, row["task_id"]))
    write_csv("scores.csv", ["rank"] + list(scored[0].keys())[:-1], scored)
    scenarios = sensitivity(output, weights, config["fit_dimensions"], config["sensitivity_delta"])
    write_csv("sensitivity.csv", ["scenario", "weights", "top_five", "changed"], scenarios)
    return scored, scenarios


def compare_ranks(config):
    before_path = ROOT / "data/scores_before.csv"
    if not before_path.exists():
        return []
    before = {row["task_id"]: row for row in read_csv(before_path)}
    after = {row["task_id"]: row for row in read_csv(ROOT / "data/scores.csv")}
    weights = config["weights"]
    labels = {"tool_page_traffic": "free-tool page traffic", "keyword_volume_rollup": "keyword volume", "mcp_usage_signal": "Smithery signal (now log-scaled, capped)", "trend_growth": "keyword trend"}

    def contributions(table):
        out = defaultdict(dict)
        for field, weight in weights.items():
            values = {task: number(row.get(field)) or 0 for task, row in table.items()}
            top = max(math.log1p(value) for value in values.values()) or 1
            for task, value in values.items():
                out[task][field] = weight * math.log1p(value) / top
        return out

    old, new = contributions(before), contributions(after)
    rows = []
    for task, row in after.items():
        prior = before[task]
        change = int(prior["rank"]) - int(row["rank"])
        reasons = []
        if abs(change) >= 3:
            deltas = sorted(((new[task][field] - old[task][field], field) for field in weights), key=lambda item: -abs(item[0]))
            for delta, field in deltas:
                if abs(delta) >= 0.02:
                    reasons.append(f"{labels[field]} {num_text(prior.get(field))} -> {num_text(row.get(field))} (score contribution {delta:+.3f})")
            fit_delta = float(row["fit"]) - float(prior["fit"])
            if abs(fit_delta) >= 0.01:
                reasons.append(f"fit {float(prior['fit']):.2f} -> {float(row['fit']):.2f} (Claude directory gap set to 5)")
            if not reasons:
                reasons.append("own score changed little; other tasks moved past it")
        rows.append({"task_id": task, "task": row["task"], "rank_before": prior["rank"], "rank_after": row["rank"], "rank_change": change, "score_before": prior["score"], "score_after": row["score"], "explanation": "; ".join(reasons)})
    rows.sort(key=lambda row: int(row["rank_after"]))
    write_csv("rank_changes.csv", ["task_id", "task", "rank_before", "rank_after", "rank_change", "score_before", "score_after", "explanation"], rows)
    return rows


def num_text(value):
    parsed = number(value) if value not in (None, "") else None
    return "n/a" if parsed is None else f"{parsed:,.1f}" if parsed < 100 else f"{parsed:,.0f}"


def export_workbook():
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    workbook = Workbook()
    workbook.remove(workbook.active)
    numeric_fields = {
        "rank", "score", "demand_index", "fit", "volume_us", "volume_global", "traffic_potential", "cpc", "keyword_difficulty", "clicks_per_search",
        "serp_position", "organic_traffic_us", "usage_count", "npm_weekly_downloads", "github_stars", "allocation", "keyword_count",
        "tool_page_traffic", "keyword_volume_rollup", "mcp_usage_signal", "trend_growth", "trend_growth_signed", "first_party_calls",
        "tool_page_trend_24m", "trend_growth_12m", "traffic_months", "keyword_topics", "volume_recent_3m", "volume_scored", "mcp_usage_uncapped", "directory_gap_open_registry",
        "rank_before", "rank_after", "rank_change", "score_before", "score_after",
        "measured_keywords", "expected_keywords", "measured_tool_pages", "mapped_mcp_listings", "observed_weight", "observed_demand_subtotal",
        "web_search_gap", "account_or_action", "recurrence", "in_workflow", "directory_gap", "willingness_to_pay",
    }

    def workbook_value(field, value):
        if value == "":
            return None
        if field in numeric_fields:
            parsed = float(value)
            return int(parsed) if parsed.is_integer() else parsed
        return value

    files = sorted((ROOT / "data").glob("*.csv"), key=lambda path: (path.stem != "scores", path.stem))
    for path in files:
        sheet = workbook.create_sheet(path.stem[:31])
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.reader(handle)
            fields = next(reader)
            sheet.append(fields)
            for values in reader:
                sheet.append([workbook_value(field, value) for field, value in zip(fields, values)])
                for cell in sheet[sheet.max_row]:
                    if isinstance(cell.value, str):
                        cell.data_type = "s"
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="245A4F")
        for column in sheet.columns:
            width = max(len(str(cell.value or "")) for cell in list(column)[:100])
            sheet.column_dimensions[column[0].column_letter].width = min(65, max(14, width + 2))
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
    path = ROOT / "seo-mcp-demand.xlsx"
    workbook.save(path)
    reopened = load_workbook(path, read_only=True)
    for source in files:
        with source.open(newline="", encoding="utf-8-sig") as handle:
            values = list(csv.reader(handle))
        actual = list(reopened[source.stem[:31]].values)
        expected = [tuple(values[0])] + [tuple(workbook_value(field, value) for field, value in zip(values[0], row)) for row in values[1:]]
        if len(actual) != len(expected) or any(
            not (abs(found - wanted) <= 1e-10 * max(1, abs(wanted)) if isinstance(found, (float, int)) and isinstance(wanted, (float, int)) else found == wanted)
            for actual_row, expected_row in zip(actual, expected) for found, wanted in zip(actual_row, expected_row)
        ):
            raise ValueError(f"Workbook differs from {source.name}")
    reopened.close()
    print(f"Workbook verified against all {len(files)} CSVs")


def request_plan(config):
    seeds = len(read_csv(ROOT / "data/seeds.csv"))
    tasks = len(TASKS)
    plan = [
        {"stage": "seed_metrics_us", "request_upper_bound": seeds, "detail": "One US keyword report per seed; cached before expansion"},
        {"stage": "related_expansions", "request_upper_bound": seeds, "detail": f"At most {config['expansions_per_seed']} related terms per seed, metrics included where supported"},
        {"stage": "serp_discovery", "request_upper_bound": tasks * config["serp_queries_per_task"], "detail": "Core, checker and free-tool seeds; up to 20 results each"},
        {"stage": "tool_page_traffic", "request_upper_bound": tasks * config["tool_pages_per_task"], "detail": "Only SERP-discovered, reviewed free tools; shared URLs fetched once"},
        {"stage": "global_and_24_month_history", "request_upper_bound": "unconfirmed", "detail": "Report support/catalog required; not included in confirmed call estimate"},
    ]
    write_csv("request_plan.csv", ["stage", "request_upper_bound", "detail"], plan)


def main():
    generate()
    from prepare import main as prepare
    prepare()
    generate_public()
    config = json.loads((ROOT / "scripts/config.json").read_text())
    signals = read_csv(ROOT / "data/mcp_signals.csv")
    fit = build_fit(signals)
    raw, grouped = keywords()
    toolpages = pages()
    scored, scenarios = build_scores(raw, grouped, toolpages, signals, fit, config)
    compare_ranks(config)
    request_plan(config)
    from report import write_report
    write_report(scored, scenarios, signals, config)
    export_workbook()
    print(f"Built {len(scored)} task rows; {sum(row['score'] is not None for row in scored)} have complete measured demand")


if __name__ == "__main__":
    main()