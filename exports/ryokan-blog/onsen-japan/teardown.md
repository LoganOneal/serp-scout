# SERP teardown: onsen japan

Pulled 2026-11-21 by **WebSearch** (Semrush returned `no_api_units`, so there are no positions or KD
from this pull). Calendar volumes: Semrush 9,900, Google 18,100 (close variants grouped), KD 12.
`serp.json` holds the "onsen japan" results in WebSearch order (#1 to #6). Because the SERP is
mixed, I added the best-ranked articles for the secondaries "best onsen in japan" and
"onsen etiquette" (#7 to #12). Pages were read in full on 2026-11-21 in the in-app browser.
Marriott Traveler (#4) returned 403.

## 1. What the searcher wants
- **Intent:** a first-time visitor planning Japan who wants to know what an onsen is, how to use one
  without embarrassment (nudity, washing, towels, tattoos), and where to go for a good one. Many will
  end up deciding whether to book a ryokan with a bath.
- **SERP mix (`pages-summary.json`):** 6 blog/editorial, 3 big guide sites, 1 encyclopedia, plus
  Wikipedia pages for single onsen towns (Kusatsu, Geto, Ofuka, Yunokawa). It's a pillar query with
  no clear owner. Three formats compete: the explainer (Lonely Planet, japan-experience,
  kashiwaya.org), the how-to (Tokyo Cheapo) and the list of towns (japan-guide, tofugu, jrailpass).
- **Format we'll use:** one guide that does all three in order: a short definition, the step-by-step
  etiquette, the types of bath, then where to go, by region, with our data. This is the only
  format that answers the whole query on one page.

## 2. Competitor by competitor

### 1. japan-experience.com: "Onsen in Japan: A Cultural Guide" (blog/editorial, 1,858 words, published 2026-01-30)
- **What works:** covers the culture (hadaka no tsukiai), the health claims, the 25°C definition,
  mineral types (sulfur, sodium chloride, iron, carbonated, radium), rules, ryokan versus public baths,
  6 top towns, and tattoos.
- **Missing or wrong:**
  - It tells readers to "rinse off after bathing". Most guides, and most Japanese bathers, say not to
    rinse after the last soak unless your skin is sensitive. The advice is muddled.
  - It says pregnant women should be "strongly advised against" onsen. Japan's Ministry of the
    Environment dropped pregnancy as a contraindication in 2014; we won't repeat the claim either way
    without reading the source today.
  - No numbers on where to stay and no inn names. The page ends by selling its own tours.
  - It confuses sento with onsen ("sento offer a chance to soak in onsen waters").
- **Facts to check:** 25°C threshold and the 19 substances (confirmed today on prefectural pages
  citing the Hot Springs Act, Article 2).

### 2. japan-guide.com/e/e2292.html (big guide site, 996 words of text plus ratings widgets)
- **What works:** a hub. It has a short definition, links to "how to take a bath" and "types of
  baths", and **the best onsen by region with user ratings** (Kanto: Kusatsu, Hakone, Okukinu;
  Hokkaido: Noboribetsu; Tohoku: Nyuto, Zao, Ginzan; Chubu: Okuhida, Shirahone, Shibu; Kansai:
  Kinosaki, Arima; Shikoku: Dogo; Kyushu: Kurokawa, Beppu, Yufuin).
- **Missing:** the page itself answers almost nothing. Every question sends you to a sub-page.
  There are no prices, no inns and no tattoo answer.
- **Lesson:** the regional "where to go" grid is what Google rewards here. We'll do it with our
  own counts and price ranges instead of star ratings.

### 3. lonelyplanet.com: "Everything You Need to Know About Visiting an Onsen" (big guide site, 2,163 words, Oct 24 2026)
- **What works:** the clearest step-by-step (shoes, pay, noren colors and 男/女 kanji, lockers,
  washing on a stool, towel on head, temperatures 34–42°C, don't shower after), when to go (winter,
  avoid Golden Week, Obon and New Year), how long to spend, and 10 standout onsen.
- **Missing:**
  - Tattoos get two sentences. There are no numbers on how few places allow them.
  - The private-bath (kashikiri) option is one line.
  - There's no "is this bath really hot-spring water?" point at all.
  - The best-onsen list is mostly single baths, with no way to book a night.
- **Facts it states:** entry ¥400–800, up to ¥2,000. Towel rental about ¥300. We won't use these
  without our own source.

### 5. kashiwaya.org: "Japanese Onsen Guide" (a ryokan's own blog, 2,134 words, Nov 7 2026)
- **What works:**
  - The best explanation of bath types: shared, rotenburo, private and in-room, and konyoku.
  - It makes the point that "private" and "open-air" don't mean hot-spring water.
  - It covers overnight versus day use, foot baths and drinkable springs.
- **Missing:** it's a sales page for one inn in Shima Onsen. There's no where-to-go list, no data,
  and nothing on tattoos beyond "check".
- **Our edge:** we can prove the same point with numbers. 1,700 of our 2,598 ryokan have hot-spring
  water, so about 900 don't. Even famous inns run plain hot water in their room baths: Nishimuraya
  Honkan's room baths are heated plain water, because Kinosaki keeps its spring water for the
  shared baths.

### 6. Wikipedia "Onsen" (encyclopedia, 4,789 words)
- Covers the definition, history, mixed bathing, etiquette, benefits, risks and resource
  management. It's not beatable on authority, but it isn't a practical guide.

### 7–9. tofugu.com (3,950 words), jrailpass.com (1,217 words), Lonely Planet top 10 (the same article as #3)
- **What works:** a ranked list of towns with a paragraph each. Tofugu's list is Beppu, Kusatsu,
  Atami, Yufuin, Hakone, Dogo, Gero, Kinugawa, Arima, Noboribetsu, and it closes on "choosing
  the best for you".
- **Missing:** nothing on where to stay or what it costs, and no picking by need (private bath,
  tattoos, near Tokyo).

### 10. tokyocheapo.com: "How to Onsen in Japan" (2,605 words)
- **What works:**
  - A guided walk through the changing room, washing area, bath and lounge.
  - A step-by-step list and a "rules" list.
  - An FAQ covering tattoos, sento versus onsen, shaving, periods, and families: children under
    about 7 can go into the other parent's bath.
- **Missing:** where to stay; any data. It's Tokyo-centric, and the prices it gives are
  auto-converted.

## 3. Forum and question signals
| Question (source) | Answered in |
| --- | --- |
| What is an onsen / onsen meaning? (autocomplete: "what is onsen japan", "onsen japan meaning") | Opening + "What counts as an onsen" |
| Onsen etiquette / what to do / what to wear? (autocomplete, WebSearch) | "How to use an onsen, step by step" + "Onsen rules" |
| Onsen and tattoos / why no tattoos? (autocomplete x4) | "Onsen with tattoos" |
| Private onsen? (autocomplete "onsen japan private") | "Private onsen" |
| Onsen vs sento? (autocomplete) | "Onsen, sento and ryokan baths" |
| Onsen cost / price? (autocomplete) | FAQ |
| Where is the best onsen / where to go? (autocomplete "where best onsen japan", "where to go onsen japan") | "The best onsen towns in Japan, by region" |
| Onsen near Tokyo? (autocomplete "onsen japan tokyo") | Region table + FAQ |
| Is it mixed gender? | "Types of bath" (konyoku) + FAQ |
| Can kids go? Period? (Tokyo Cheapo FAQ, WebSearch) | FAQ |
| Where to stay for onsen? (autocomplete) | At a glance + "Where to stay for your first onsen" |
- **Worries in the results:** nudity, getting the steps wrong in front of locals, tattoos, mixed
  bathing, whether a private bath is "real" onsen, and crowds at Golden Week, Obon and New Year.

## 4. Must-cover topics
Definition (and onsen versus sento); step-by-step etiquette; the rules (towel, phone, hair, no
swimsuits, no swimming, quiet, no alcohol); types of bath (rotenburo, kashikiri, in-room, konyoku,
foot baths); tattoos; health and minerals (briefly); best onsen towns; overnight versus day trip;
when to go; how long to soak.

## 5. Win plan: material improvements
1. **Official count of onsen.** Japan had 2,839 hot-spring areas with lodging and 27,899 hot
   springs as of March 2025. Oita has the most springs (5,094) and Hokkaido the most onsen areas
   (226). — *Ministry of the Environment, "令和6年度温泉利用状況", read today.* — *Opening and "What
   counts as an onsen".* Competitors quote "about 3,000" or "2,300 to 3,000" with no source.
2. **Proof that "private" and "open-air" aren't always hot-spring water.**
   - 1,700 of the 2,598 ryokan we list have hot-spring water in at least some baths, and 1,580 in
     every bath.
   - Nishimuraya Honkan's open-air room baths use heated plain water.
   - At Mount View Hakone only the open-air baths are milky Owakudani water; the indoor baths are
     heated groundwater.
   - *Sources: ryokansociety.com/ryokans filter counts and inn pages, read today.* — *Where:*
     "Types of bath" and in Kai's own passage.
3. **Tattoo numbers.** Only 25 of our 2,598 ryokan say tattoos are fine in their shared baths, but
   1,331 let you bathe privately. — *ryokansociety.com/ryokans?tattoos=fine and ?tattoos=private,
   checked today.* — *"Onsen with tattoos".*
4. **Private onsen numbers.** 726 ryokan have a bath in some or all rooms, and 996 have a private
   bath to book. — *?bath=room, ?bath=private, today.* — *"Private onsen".*
5. **The best onsen towns, by region, with real numbers.** For each town: our ryokan count, the usual
   price for two a night, and how many have a private bath. — *destination pages read today.* —
   *Region table.* No competitor has prices.
6. **Where to stay for your first onsen, by need.** Five inns, each with a reason from its page:
   heritage onsen town, an open-air hot-spring bath in every room, tattoos allowed, milky water at
   a low price, and free private baths. — *inn pages read today.* — *At a glance + H3s.*
7. **Kai's view.** How to read a Japanese inn's bath description (源泉掛け流し, 加水, 循環) and how to
   ask about tattoos politely. This is something only someone raised in a Japanese hotel family
   writes. — *Where:* "How to tell if a bath is real hot-spring water".

## 6. Targets for our post
- **Word count:** 2,300 to 2,900. The top-3 article median is 1,858 and the median for all pages is
  2,163. It's longer only because of the region table and the where-to-stay picks.
- **Must include:**
  - an at-a-glance table
  - a step-by-step numbered list
  - the region table (towns, counts, prices)
  - bath types
  - tattoos
  - a FAQ
  - an end CTA H2
- **Internal links:**
  - /ryokans with filters (onsen, bath, tattoos)
  - /private-onsen and /onsen-hotels
  - 10 destination pages: Kusatsu, Hakone, Kinosaki, Arima, Beppu, Yufuin, Kurokawa, Noboribetsu,
    Nyuto, Dogo
  - 5 inn pages
  - /how-we-verify
- **Booking-page guard:** don't target or use as an H2 "onsen ryokan", "best ryokan in japan",
  "private onsen" or "ryokan with private onsen". Those belong to /ryokans and /private-onsen.
  The H2 on private baths is phrased as a travel question: "Can you bathe privately?"
