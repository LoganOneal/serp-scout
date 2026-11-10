# Web-search task for one chunk of a run's search plan

You are given RUN (an absolute run directory) and CHUNK (a 0-based index). Scripts:
S=/Users/kaisulkin/serp-scout/.agents/skills/guest-post-pitches/scripts

1. Load the WebSearch tool via ToolSearch ("select:WebSearch").
2. Read RUN/search-plan.json and take `chunks[CHUNK]`: a list of {"batch": <batch dir>, "domain": ...}.
   For each entry, read <batch>/websearch_log.json if present and skip the domain if it is already
   logged, unless its note contains "refused".
3. ONE DOMAIN AT A TIME (never send several WebSearch calls in parallel; wait for each result
   before the next search), for each remaining entry:
   a. Run ONE WebSearch with query "<domain> write for us guest post contribute submissions" and
      allowed_domains=["<domain>"] (mode "standard").
   b. From the results keep only same-domain URLs that look like a contributor, guest-post,
      write-for-us, submissions, pitch, freelance or contact page (max 3). Ignore ordinary articles.
   c. For each kept URL run, in Bash (ignore failures):
        cd <batch> && python3 $S/research_tools.py fetch <domain> --url <url>
   d. Log it, in Bash:
        cd <batch> && python3 $S/websearch_log.py add <domain> <kept urls...> --note "light policy: one site: query via allowed_domains filter"
      With no kept URLs, run the same command with no URLs. If the search was refused for that one
      domain (site blocked, too_many_requests), add --note "search refused: <short reason>".
      If the refusal says the turn or session web-search budget is used up, STOP immediately:
      do not log that domain or any later one, and list the unsearched domains in your reply.
4. Edit no other file. Do not write pitches, send anything or fill forms.
5. Reply with one line only: "done chunk <CHUNK> <domains logged> logged, <domains with URLs> with URLs"
   (plus the unsearched domains if you stopped).
