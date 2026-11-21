"""Build posts.json: one row per planned post, with the validated target keyword.
Inputs: semrush-variants.csv (US exact-match volume, KD), gads-volumes*.json (Google Ads US, close variants grouped),
variants.json (variant pool per topic)."""
import json
MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
sem = {}
for l in open("semrush-variants.csv"):
    k, v, kd = l.strip().split(";"); sem[k] = (int(v), int(kd) or None)
g = {}
for f in ("gads-volumes.json", "gads-volumes-extra.json"):
    for r in json.load(open(f))["rows"]:
        g[r["keyword"]] = r
pools = json.load(open("variants.json"))
X = lambda *ks: list(ks)
# (title, target, secondaries, pool topic(s) + extra variants, fit, type, note)
P = [
 ("Japan in December: weather, crowds and the best ryokan stays", "japan in december", ["japan december", "japan in december weather", "tokyo in december", "visiting japan in december"], [], X("japan in december","japan december","japan in december weather","tokyo in december","visiting japan in december"), "Medium", "Seasonal", "Google groups weather searches into a bigger cluster (6,600); cover weather as its own section."),
 ("Winter in Japan: snow, onsen and when to go", "japan winter", ["winter in japan", "japan in winter", "when is winter in japan"], ["Winter in Japan"], [], "High", "Seasonal", ""),
 ("Tattoo-friendly onsen and ryokan in Japan", "tattoo friendly onsen", ["tattoo friendly onsen tokyo", "onsen tattoo", "onsen with tattoos", "tattoo friendly ryokan"], ["Tattoo-friendly onsen"], [], "Very high", "Data", "Uses the 25-of-2,598 count. Doubles as the press data page."),
 ("Ryokan with a private onsen: where to book one", "private onsen", ["ryokan with private onsen", "private onsen ryokan", "private onsen tokyo", "private onsen japan"], ["Ryokan with a private onsen"], [], "Very high", "Data", "Uses the 1,331 private-bath count."),
 ("Onsen in Japan: a first-timer's guide", "onsen japan", ["best onsen in japan", "onsen etiquette", "onsen rules", "onsen meaning"], ["Onsen in Japan guide"], X("what is an onsen","onsen meaning","japanese bath house"), "High", "Pillar", "Long-term goal: 'onsen' (49,500, KD 70)."),
 ("The best ryokan in Hakone", "hakone ryokan", ["ryokan hakone", "best ryokan in hakone", "hakone onsen ryokan", "luxury ryokan hakone", "hakone ryokan with private onsen"], ["Best ryokan in Hakone"], [], "Very high", "Booking", ""),
 ("The best ryokan in Kyoto", "ryokan kyoto", ["kyoto ryokan", "ryokan in kyoto", "best ryokan in kyoto", "luxury ryokan kyoto"], ["Best ryokan in Kyoto"], [], "Very high", "Booking", ""),
 ("Kinosaki Onsen: the seven baths and where to stay", "kinosaki onsen", ["kinosaki onsen town", "kinosaki onsen ryokan", "kinosaki ryokan"], ["Kinosaki Onsen guide"], X("kinosaki onsen guide"), "Very high", "Town", "43 ryokan listed on the site."),
 ("Shibu Onsen and the snow monkeys: a winter ryokan trip", "shibu onsen", ["shibu onsen ryokan", "snow monkeys japan", "jigokudani monkey park"], ["Shibu Onsen and the snow monkeys"], X("snow monkey park","shibu onsen snow monkeys"), "High", "Town", ""),
 ("The best onsen ryokan in Japan", "onsen ryokan", ["best ryokan in japan", "luxury ryokan", "best onsen ryokan in japan"], [], X("onsen ryokan","best ryokan in japan","luxury ryokan","best onsen ryokan","onsen ryokan japan","best onsen ryokan in japan"), "Very high", "Booking", ""),
 ("Zao Onsen: snow monsters, skiing and hot springs", "zao onsen", ["zao onsen ski resort", "zao snow monsters"], ["Zao Onsen"], [], "High", "Town", ""),
 ("Nyuto Onsen: Tsurunoyu and the hidden baths of Akita", "nyuto onsen", ["tsurunoyu onsen"], ["Nyuto Onsen"], [], "High", "Town", ""),
 ("Onsen in Kyoto: the best hot springs in and near the city", "kyoto onsen", ["onsen in kyoto", "onsen kyoto", "kyoto onsen ryokan", "onsen near kyoto"], ["Onsen in Kyoto"], [], "High", "Town", ""),
 ("Kaiseki dinner at a ryokan, explained", "kaiseki dinner", ["kaiseki", "what is kaiseki", "kaiseki ryori", "ryokan dinner"], [], X("kaiseki","kaiseki dinner","what is kaiseki","kaiseki restaurant","kaiseki meal","kaiseki ryori","ryokan dinner","kaiseki dinner ryokan"), "High", "Food", "'kaiseki restaurant' is bigger (1,600, KD 19) but mostly US diners looking for a restaurant near them."),
 ("Kaiseki vs omakase: what's the difference?", "kaiseki vs omakase", ["omakase vs kaiseki"], [], X("kaiseki vs omakase","omakase vs kaiseki"), "Medium", "Food", ""),
 ("Where to stay in Kyoto: neighborhoods, hotels and ryokan", "where to stay in kyoto", ["best hotels in kyoto", "best area to stay in kyoto", "best place to stay in kyoto"], ["Where to stay in Kyoto"], [], "High", "Booking", ""),
 ("What is a ryokan? A guide to Japan's traditional inns", "what is a ryokan", ["ryokan meaning", "ryokan japan", "japanese ryokan", "ryokan vs hotel"], [], X("ryokan","what is a ryokan","ryokan meaning","ryokan japan","japanese ryokan","japanese inn","ryokan vs hotel"), "High", "Pillar", "Long-term goal: 'ryokan' (40,500, KD 44)."),
 ("Things to do in Hakone", "things to do in hakone", ["hakone things to do", "hakone day trip", "hakone itinerary"], [], X("things to do in hakone","hakone things to do","hakone day trip","hakone itinerary","hakone","hakone japan"), "Medium", "Town", ""),
 ("Tokyo to Hakone: how to get there (and why to stay the night)", "tokyo to hakone", ["tokyo to hakone day trip", "how to get to hakone from tokyo"], [], X("tokyo to hakone","tokyo to hakone day trip","how to get to hakone from tokyo"), "Medium", "Town", ""),
 ("Takayama, Japan: a guide to Hida Takayama", "takayama japan", ["hida takayama", "takayama ryokan", "things to do in takayama", "where to stay in takayama"], ["Takayama travel guide"], X("hida takayama japan"), "Medium", "Town", ""),
 ("Kanazawa, Ishikawa, Japan: what to see and where to stay", "kanazawa ishikawa japan", ["kanazawa hotels", "things to do in kanazawa", "kanazawa ryokan"], ["Kanazawa guide"], [], "Medium", "Town", "Odd phrasing; Google treats it as part of the 'kanazawa' group (40,500). Use 'Kanazawa, Japan' in the H1."),
 ("Japan itinerary: 10 days with a ryokan night", "japan itinerary 10 days", ["10 day japan itinerary", "japan itinerary 7 days", "7 day japan itinerary"], [], X("japan itinerary","japan itinerary 10 days","10 day japan itinerary","japan itinerary 7 days","7 day japan itinerary","1 week japan itinerary"), "Medium", "Itinerary", ""),
 ("The 2-week Japan itinerary", "2 week japan itinerary", ["japan two week itinerary", "japan itinerary 2 weeks", "japan itinerary 14 days"], [], X("2 week japan itinerary","japan two week itinerary","japan itinerary 2 weeks","japan itinerary 14 days"), "Medium", "Itinerary", ""),
 ("Japan in January: weather, snow festivals and onsen", "japan in january", ["japan in january weather", "visiting japan in january"], [], X("japan in january","japan january","japan in january weather","visiting japan in january"), "Medium", "Seasonal", "Google groups weather searches into a bigger cluster (3,600); cover weather as its own section."),
 ("Onsen in Tokyo: city baths and the best hot springs nearby", "onsen tokyo", ["tokyo onsen", "onsen in tokyo", "onsen near tokyo", "hot spring tokyo"], ["Onsen in Tokyo"], [], "Medium", "Town", ""),
 ("Kurokawa Onsen: Kyushu's prettiest hot-spring village", "kurokawa onsen", ["kurokawa onsen ryokan"], ["Kurokawa Onsen"], [], "High", "Town", ""),
 ("Takaragawa Onsen: Japan's giant riverside baths", "takaragawa onsen", ["takaragawa onsen osenkaku"], ["Takaragawa Onsen"], [], "Medium", "Town", "A single-inn onsen. Check that Osenkaku is listed."),
 ("Kinugawa Onsen: an easy hot-spring trip from Tokyo", "kinugawa onsen", ["kinugawa onsen ryokan"], ["Kinugawa Onsen"], [], "High", "Town", ""),
 ("Noboribetsu Onsen: Hell Valley and Hokkaido's best ryokan", "noboribetsu", ["noboribetsu onsen", "noboribetsu ryokan"], ["Noboribetsu Onsen"], [], "High", "Town", ""),
 ("Things to do in Nikko, plus a night at Kinugawa", "things to do in nikko", ["nikko day trip"], ["Nikko"], [], "Medium", "Town", "Long-term goal: 'nikko' (18,100, KD 44)."),
 ("Arima Onsen: gold and silver springs an hour from Osaka", "arima onsen", ["arima hot springs", "arima onsen ryokan"], ["Arima Onsen"], [], "High", "Town", ""),
 ("Kusatsu Onsen: the yubatake and where to stay", "kusatsu onsen", ["kusatsu onsen ryokan", "kusatsu"], ["Kusatsu Onsen"], [], "High", "Town", ""),
 ("Beppu: Japan's hot-spring capital", "beppu", ["beppu onsen", "beppu ryokan", "beppu hot springs"], ["Beppu onsen guide"], [], "High", "Town", ""),
 ("Yufuin: a quiet onsen town in Kyushu", "yufuin", ["yufuin onsen", "yufuin ryokan"], ["Yufuin"], [], "High", "Town", ""),
 ("Ginzan Onsen: the snow-lit town and its ryokan", "ginzan onsen", ["ginzan onsen ryokan"], ["Ginzan Onsen"], [], "High", "Town", ""),
 ("Dogo Onsen: Japan's oldest hot spring", "dogo onsen", ["dogo onsen honkan"], ["Dogo Onsen"], [], "High", "Town", ""),
 ("Gero Onsen: one of Japan's three great hot springs", "gero onsen", ["gero onsen ryokan"], ["Gero Onsen"], [], "High", "Town", ""),
 ("Yukata: how to wear one at a ryokan", "yukata", ["ryokan etiquette"], ["Ryokan etiquette"], [], "Low", "Pillar", "Huge but mostly shoppers buying a yukata. Write it last, if at all."),
]
def kd_of(k): return sem.get(k, (None, None))[1]
def sv(k): return sem.get(k, (None, None))[0]
def gv(k): return (g.get(k) or {}).get("avgMonthlySearches")
def peak(k):
    ms = (g.get(k) or {}).get("monthlySearches") or []
    return MON[max(ms, key=lambda m: m["searchVolume"])["month"] - 1] if ms else None
owner = {}
for i, (_, tgt, sec, *_r) in enumerate(P, 1):
    for k in [tgt] + sec: owner.setdefault(k, i)
def label(kd):
    return None if kd is None else "Easy" if kd < 20 else "Possible" if kd < 30 else "Harder" if kd < 40 else "Hard"
out = []
for i, (title, tgt, sec, topics, extra, fit, typ, note) in enumerate(P, 1):
    pool = [k for k in dict.fromkeys([k for t in topics for k in pools[t]] + extra + [tgt] + sec) if owner.get(k, i) == i]
    rows = [{"kw": k, "s": sv(k), "g": gv(k), "kd": kd_of(k), "cv": [c for c in (g.get(k) or {}).get("closeVariants", []) if c != k]} for k in pool if sv(k) is not None or gv(k) is not None]
    rows.sort(key=lambda r: -(r["s"] or 0))
    smax = max(r["s"] or 0 for r in rows); gmax = max(r["g"] or 0 for r in rows)
    t = next(r for r in rows if r["kw"] == tgt)
    bigger_s = [r for r in rows if (r["s"] or 0) > (t["s"] or 0)]
    bigger_g = [r for r in rows if (r["g"] or 0) > (t["g"] or 0) and t["kw"] not in r["cv"] and r["kw"] not in t["cv"]]
    if not bigger_s and not bigger_g:
        status, verdict = "top", "Biggest variant in both Semrush and Google."
    else:
        parts = []
        for r in sorted({r["kw"]: r for r in bigger_s + bigger_g}.values(), key=lambda r: -(r["s"] or 0)):
            why = f"KD {r['kd']}" if r["kd"] and r["kd"] > (t["kd"] or 0) + 5 else ""
            parts.append(f"{r['kw']} (S {r['s']:,} · G {r['g'] or 0:,}{' · ' + why if why else ''})")
        hard = all((r["kd"] or 0) >= 35 for r in bigger_s + bigger_g)
        status = "reachable" if hard else "split"
        verdict = ("Biggest variant you can realistically rank for. Bigger but much harder: " if hard else "Judgment call. Bigger in one source: ") + "; ".join(parts)
    out.append(dict(n=i, title=title, target=tgt, secondaries=sec, sem=t["s"], google=t["g"], kd=t["kd"], peak=peak(tgt), difficulty=label(t["kd"]),
                    group=t["cv"], status=status, verdict=verdict, fit=fit, type=typ, note=note, variants=rows))
json.dump(out, open("posts.json", "w"), indent=1)
for p in out:
    print(f"{p['n']:>2} {p['target']:<26} S {p['sem']:>6} G {str(p['google']):>6} KD {p['kd']} peak {p['peak']} [{p['status']}] {p['verdict'][:150]}")
