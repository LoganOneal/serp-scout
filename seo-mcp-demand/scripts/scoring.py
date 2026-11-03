"""Pure scoring functions. Unknown measurements remain None, not zero."""

import itertools
import math
from collections import defaultdict


def number(value):
    if value is None or value == "":
        return None
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"Expected a finite nonnegative measurement, got {value!r}")
    return result


def normalize(values):
    parsed = [number(value) for value in values]
    maximum = max((math.log1p(value) for value in parsed if value is not None), default=0)
    return [None if value is None else math.log1p(value) / maximum if maximum else 0.0 for value in parsed]


def group_keywords(rows):
    groups = defaultdict(list)
    for row in rows:
        parent = row.get("parent_topic", "").strip().lower()
        if not parent:
            continue
        groups[parent].append(row)
    result = []
    for parent, members in sorted(groups.items()):
        tasks = sorted({task_id for row in members for task_id in row["task_ids"].split("|") if task_id})
        for task_id in tasks:
            grouped = {"task_id": task_id, "parent_topic": parent, "keywords": "|".join(sorted({row["keyword"] for row in members})), "keyword_count": len({row["keyword"] for row in members}), "allocation": 1 / len(tasks)}
            for field in ("volume_us", "volume_scored", "volume_global", "traffic_potential"):
                observed = [number(row.get(field)) for row in members if number(row.get(field)) is not None]
                grouped[field] = max(observed) / len(tasks) if observed else None
            grouped["rollup_method"] = "max_per_parent_topic_equal_task_allocation"
            result.append(grouped)
    return result


def trend_growth(series):
    if not series or len(series) != 24:
        return None
    values = [number(value) for value in series]
    if any(value is None for value in values):
        return None
    start = sum(values[:3]) / 3
    if start == 0:
        return None
    return (sum(values[-3:]) / 3) / start - 1


def score_tasks(rows, weights, dimensions):
    if not math.isclose(sum(weights.values()), 1.0, abs_tol=1e-8) or any(value < 0 for value in weights.values()):
        raise ValueError("Demand weights must be nonnegative and sum to 1")
    if "first_party_calls" in weights and weights["first_party_calls"] < 0.3:
        raise ValueError("First-party weight must be at least 0.3")
    normalized = {field: normalize([row.get(field) for row in rows]) for field in weights}
    output = []
    for index, row in enumerate(rows):
        result = dict(row)
        fit_values = [number(row[dimension]) for dimension in dimensions]
        if any(value is None or not 1 <= value <= 5 for value in fit_values):
            raise ValueError("All fit dimensions must be in [1, 5]")
        result["fit"] = sum(fit_values) / (5 * len(dimensions))
        observed = {field: normalized[field][index] for field in weights if normalized[field][index] is not None}
        result["observed_weight"] = sum(weights[field] for field in observed)
        result["missing_components"] = "|".join(field for field in weights if field not in observed)
        result["observed_demand_subtotal"] = sum(weights[field] * value for field, value in observed.items())
        result["demand_index"] = result["observed_demand_subtotal"] if len(observed) == len(weights) else None
        result["score"] = result["demand_index"] * result["fit"] if result["demand_index"] is not None else None
        result["status"] = "measured" if result["score"] is not None else "incomplete_not_rankable"
        output.append(result)
    return output


def sensitivity(rows, weights, dimensions, delta=0.1):
    if any(row.get(field) is None for row in rows for field in weights):
        return [{"scenario": "blocked", "weights": "", "top_five": "", "changed": "unknown_missing_demand_components"}]
    baseline = [row["task_id"] for row in sorted(score_tasks(rows, weights, dimensions), key=lambda row: (-row["score"], row["task_id"]))[:5]]
    scenarios = [{"scenario": "baseline", "weights": str(weights), "top_five": "|".join(baseline), "changed": False}]
    for donor, recipient in itertools.permutations(weights, 2):
        adjusted = dict(weights)
        if adjusted[donor] < delta:
            continue
        adjusted[donor] -= delta
        adjusted[recipient] += delta
        if "first_party_calls" in adjusted and adjusted["first_party_calls"] < 0.3:
            continue
        top = [row["task_id"] for row in sorted(score_tasks(rows, adjusted, dimensions), key=lambda row: (-row["score"], row["task_id"]))[:5]]
        scenarios.append({"scenario": f"{donor} -{delta}; {recipient} +{delta}", "weights": str(adjusted), "top_five": "|".join(top), "changed": top != baseline})
    return scenarios