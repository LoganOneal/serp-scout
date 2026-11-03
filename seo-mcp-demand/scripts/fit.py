"""Analyst fit judgments, not measured demand. Each dimension has its own rationale."""

from study import TASKS, write_csv

# Kai's manual check of the Claude Connectors Directory: no dedicated connector for these.
CLAUDE_DIRECTORY_GAPS = {"gsc_top", "gsc_opportunity", "gsc_drop", "index_status", "index_submit", "index_diagnose", "serp_results"}

JUDGMENTS = {
    "kw_volume": (5, 1, 5, 5, 5, "Keyword volumes require a provider dataset, not web snippets.", "Public keyword data needs no owned-account permission.", "Validate keywords for every new page and content batch.", "Choosing a target keyword is a natural writing-agent step.", "Commercial keyword datasets and APIs are paid products."),
    "kw_ideas": (4, 1, 5, 5, 4, "Useful demand-ranked ideas need provider metrics; generic brainstorming is built in.", "Topic research does not require the user's account.", "Repeat for each new topic and content batch.", "Research fits directly before drafting.", "Incumbents sell research, but generic suggestions are commoditized."),
    "kw_difficulty": (5, 1, 4, 4, 4, "Difficulty requires provider ranking and backlink data.", "Difficulty is public estimated data, not account-specific.", "Recheck target selection and periodic content planning.", "Useful during target selection, less during implementation.", "Difficulty is a paid research-suite feature; provider definitions differ."),
    "serp_results": (5, 1, 5, 5, 5, "Structured location/device-specific SERPs exceed a generic web-search summary.", "Public SERPs do not require account access.", "SERPs change and are checked per target and weekly.", "SERP evidence naturally grounds briefs and optimization.", "SERP data is a core standalone API product."),
    "rank_position": (5, 2, 5, 4, 5, "Exact localized rankings and history need repeatable structured retrieval.", "Tracked domain configuration is useful but not private analytics.", "Tracking is inherently daily or weekly.", "Agents can check outcomes after content and deploy changes.", "Rank tracking is a paid recurring incumbent category."),
    "serp_aio": (5, 1, 5, 4, 4, "Overview presence and content require live structured SERP extraction.", "Public search results need no owned account.", "Overview contents and triggers change frequently.", "Relevant while updating content targeting AI search.", "Dedicated AI Overview endpoints show commercial API supply."),
    "gsc_drop": (5, 5, 5, 5, 3, "Private query/page/date comparisons are unavailable to built-in search.", "Requires OAuth to the user's Search Console property.", "Weekly monitoring and traffic incidents recur.", "Traffic regressions can be investigated alongside code changes.", "Raw GSC data is free; value is diagnosis rather than data resale."),
    "gsc_top": (5, 5, 5, 4, 2, "Private performance tables cannot be retrieved by public web search.", "Requires the user's Search Console property.", "Reporting and content prioritization recur weekly.", "Feeds writing workflows, but simple reports can stay in GSC.", "Free Google reporting constrains willingness to pay for raw queries."),
    "gsc_opportunity": (5, 5, 5, 5, 4, "Join private query positions to pages to identify actionable opportunities.", "Uses owned-property OAuth data.", "Repeat weekly and after content refreshes.", "Returns a concrete page-edit queue to the coding/writing agent.", "Prioritized improvement workflows can justify paid orchestration."),
    "index_status": (5, 5, 5, 5, 3, "Owned URL Inspection reports exact status; public site queries are incomplete.", "Requires verified-property access for authoritative inspection.", "Inspect each release and newly published page.", "A natural post-deploy verification step.", "Google's inspection API is free; quota-aware batching adds value."),
    "index_submit": (4, 5, 5, 5, 3, "A tool can execute an eligible submission; search cannot perform it.", "An authenticated action with provider and content restrictions.", "New and changed URLs recur per deploy.", "Natural publish/deploy hook with explicit action approval.", "Existing indexing services charge, but inclusion cannot be guaranteed."),
    "index_diagnose": (5, 5, 5, 5, 4, "Combines private inspection with crawlability and canonical diagnostics.", "Uses verified-property inspection plus page evidence.", "Recurring for new pages and indexing incidents.", "Findings map directly to robots, canonical and rendering fixes.", "Diagnosis and verified remediation add value beyond a free status lookup."),
    "audit_site": (4, 2, 5, 5, 4, "Remote crawling and history add value, but local crawlers cover many checks.", "A public crawl needs no owned-account access.", "Run after major deploys and periodically.", "Audit findings map directly to repository fixes.", "Commercial crawlers monetize scale, history and reporting."),
    "audit_speed": (3, 1, 5, 5, 3, "Field CrUX data adds a gap; agents can run lab Lighthouse locally.", "Most speed and public field data requires no owned account.", "Performance regressions should be checked per deploy.", "Performance fixes are a native coding-agent workflow.", "Free Lighthouse and PageSpeed constrain raw-check monetization."),
    "audit_links": (2, 1, 5, 5, 2, "An agent can crawl public links or inspect local routing itself.", "Public link checks require no private account.", "Broken-link checks recur per deploy.", "Directly actionable during coding and publishing.", "Many free checkers and local alternatives reduce pricing power."),
    "audit_schema": (2, 1, 5, 5, 2, "Agents can validate local JSON-LD; Google eligibility checks add limited remote value.", "Most markup checks are public or local.", "Check each template and structured-data change.", "Schema edits fit directly into code review.", "Free Google validators and local libraries constrain pricing."),
    "links_profile": (5, 1, 4, 3, 5, "A backlink graph requires a proprietary external crawl index.", "Public-domain link data needs no owned account.", "Periodic authority analysis and outreach planning recur.", "Often a separate marketing workflow, not an immediate code edit.", "Backlink datasets are established paid incumbent products."),
    "links_gap": (5, 1, 4, 3, 5, "Cross-domain link intersection requires an external backlink index.", "Competitor comparisons need no owned account.", "Repeat during outreach planning cycles.", "Supports link outreach more than code or content edits.", "Gap analysis is a commercially valuable suite feature."),
    "links_lost": (5, 2, 5, 3, 4, "Lost-link detection requires historical snapshots.", "A tracked domain is configured but its links are public.", "Monitoring loss is inherently recurring.", "Recovery is mainly an outreach workflow.", "Historical monitoring supports subscription value."),
    "comp_keywords": (5, 1, 5, 4, 5, "Competitor ranking datasets are not exposed by built-in web search.", "Competitor domains do not need account access.", "Refresh content plans and competitive checks regularly.", "Useful evidence for briefs and new-page selection.", "Incumbents charge for large competitor keyword datasets."),
    "comp_traffic": (5, 1, 4, 3, 4, "Organic estimates need a provider model; search snippets cannot measure traffic.", "Public modeled estimates require no owned account.", "Used during periodic competitive research.", "Less directly actionable than page-level opportunity discovery.", "Commercial analysis products sell traffic estimates."),
    "comp_gap": (5, 1, 5, 5, 5, "Multi-domain ranking joins require a structured provider dataset.", "Public ranking datasets require no owned account.", "Refresh opportunity lists regularly.", "Produces a natural new-page and update queue.", "Keyword/content gaps are paid research-suite features."),
    "ai_mentions": (5, 2, 5, 4, 4, "Repeated prompt/model samples are needed; a single search is not visibility measurement.", "Brand and prompt setup is needed, but underlying responses are public.", "Visibility measurement needs repeated comparable samples.", "Relevant to ongoing content and brand optimization.", "Commercial monitoring supply exists; human demand growth remains unmeasured."),
    "ai_citations": (5, 1, 5, 4, 4, "Structured overview citation retrieval needs a SERP provider.", "Public citation results require no owned account.", "Citations change across prompts, locations and time.", "Supports evidence-based content updates.", "AI SERP endpoints and monitoring products are commercial."),
    "local_rank": (5, 2, 5, 3, 5, "Geo-grid Maps rank requires many exact-location observations.", "Business and grid setup, not necessarily private account data.", "Local rank tracking is a recurring workflow.", "Mostly a local-marketing workflow rather than coding.", "Geo-grid trackers are established paid products."),
    "local_reviews": (4, 5, 5, 3, 3, "Owned review operations exceed snippets; some public reading is substitutable.", "Owned Business Profile actions require account permissions.", "New reviews and responses recur.", "Review operations are peripheral to coding and content production.", "Paid reputation management exists, but raw reviews alone are commoditized."),
    "local_audit": (4, 5, 4, 3, 3, "Owned profile diagnostics and updates exceed web-search access.", "Uses the business owner's account and potentially mutation permissions.", "Profile maintenance recurs, though less often than rank checks.", "Mainly a local operations workflow.", "Local SEO suites charge for profile management and audits."),
    "content_brief": (3, 1, 5, 5, 3, "SERP-backed evidence adds value; generic brief generation is built in.", "Public research does not require account access.", "One brief per content assignment.", "Directly precedes drafting in a writing agent.", "Monetize unique evidence rather than generic generation."),
    "content_onpage": (3, 1, 5, 5, 3, "Live competing SERPs add value; agents can inspect local HTML themselves.", "Most page analysis is public or local.", "Repeat for each publish and refresh.", "Suggestions map directly to editing page content and markup.", "Many free checks exist; differentiated data can support paid use."),
    "content_cannibal": (5, 5, 4, 5, 4, "Query/page history is needed to distinguish real overlap from matching titles.", "Uses private Search Console page/query data.", "Recheck after major content changes and monthly reviews.", "Results lead directly to merges, redirects and page edits.", "Actionable cross-page diagnosis can support paid orchestration."),
}


def build_fit(signals):
    dimensions = ["web_search_gap", "account_or_action", "recurrence", "in_workflow", "directory_gap", "willingness_to_pay"]
    rows = []
    for cluster, task_id, task, subject, notes in TASKS:
        judgment = JUDGMENTS[task_id]
        matched = [row for row in signals if task_id in row["task_ids"].split("|")]
        open_registry_gap = 2 if matched else 3
        claude_gap = 5 if task_id in CLAUDE_DIRECTORY_GAPS else open_registry_gap
        values = list(judgment[:4]) + [claude_gap, judgment[4]]
        rationales = list(judgment[5:9]) + [
            "Claude Connectors Directory has no dedicated connector for this task (Kai's manual check, 2026-10-29)."
            if task_id in CLAUDE_DIRECTORY_GAPS else
            "Not manually checked in the Claude directory; uses the open-registry score."
        ] + [judgment[9]]
        row = {"task_id": task_id, "assessment_type": "analyst_judgment_not_measured_demand", "directory_confidence": "manual_claude_check" if task_id in CLAUDE_DIRECTORY_GAPS else "open_registry_only"}
        for dimension, value, rationale in zip(dimensions, values, rationales):
            row[dimension] = value
            row[dimension + "_rationale"] = rationale
        row["directory_gap_open_registry"] = open_registry_gap
        row["directory_gap_open_registry_rationale"] = (
            f"{len(matched)} matching listings in the official MCP Registry / Smithery / Glama."
            if matched else "No matching listing found in the sampled open registries."
        )
        row["evidence"] = "|".join(sorted({entry["listing_url"] for entry in matched})[:3])
        rows.append(row)
    fields = ["task_id"] + [field for dimension in dimensions for field in (dimension, dimension + "_rationale")] + ["directory_gap_open_registry", "directory_gap_open_registry_rationale", "assessment_type", "directory_confidence", "evidence"]
    write_csv("fit_scores.csv", fields, rows)
    return rows