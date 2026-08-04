#!/usr/bin/env python3
"""SolForge wiki scraper: card list, card data (CardTable wikitext), card images.

Usage:
  python3 scrape.py list                    # fetch set-category member lists -> build/cardlists.json
  python3 scrape.py data Set_1 Set_1.5      # fetch + parse CardTable for those sets -> build/cards_<set>.json
  python3 scrape.py images build/cards_Set_1.json ...   # download card images -> assets/cards/

API notes: solforge.fandom.com blocks plain HTML scraping (403); must use api.php
with a User-Agent header. Be polite: small delay between requests.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

API = "https://solforge.fandom.com/api.php"
UA = {"User-Agent": "SolForgeCloneResearch/1.0 (personal project)"}
DELAY = 0.4
BUILD = os.path.join(os.path.dirname(__file__), "build")
ASSETS = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "cards")


def api(params, retries=3):
    url = API + "?" + urllib.parse.urlencode(params)
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            print(f"  retry {i+1}/{retries}: {e}", file=sys.stderr)
            time.sleep(2 * (i + 1))
    raise RuntimeError("api failed: " + url)


def category_members(cat):
    out, cont = [], {}
    while True:
        d = api({"action": "query", "list": "categorymembers",
                 "cmtitle": "Category:" + cat, "cmlimit": "500",
                 "format": "json", **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" not in d:
            return out
        cont = d["continue"]


def cmd_list():
    sets = ["Set 1", "Set 1.5", "Set 2", "Set 2.1", "Set 2.2", "Set 2.3",
            "Set 3", "Set 3.1", "Set 4", "Set 4.1", "Set 4.2",
            "Set 5", "Set 5.1", "Set 5.2", "Set 6", "Set 6.1", "Set 6.2",
            "Set 7", "Set 7.1", "Set 7.2", "Set 7.3"]
    os.makedirs(BUILD, exist_ok=True)
    data = {}
    for s in sets:
        data[s.replace(" ", "_")] = category_members(s)
        print(f"{s}: {len(data[s.replace(' ', '_')])}")
        time.sleep(DELAY)
    with open(os.path.join(BUILD, "cardlists.json"), "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    print("total:", sum(len(v) for v in data.values()))


def wikitext(title):
    d = api({"action": "parse", "page": title, "prop": "wikitext", "format": "json"})
    if "parse" not in d:
        return None
    return d["parse"]["wikitext"]["*"]


def parse_cardtable(title, wt):
    m = re.search(r"\{\{CardTable\s*\n(.*?)\n\}\}", wt, re.S)
    if not m:
        return None
    body = m.group(1)
    fields, cur, buf = {}, None, []
    for line in body.split("\n"):
        km = re.match(r"\|([^=]+)=\s?(.*)", line)
        if km:
            if cur:
                fields[cur] = "\n".join(buf).strip()
            cur, buf = km.group(1).strip(), [km.group(2)]
        elif cur:
            buf.append(line)
    if cur:
        fields[cur] = "\n".join(buf).strip()

    def images(key):
        return re.findall(r"^([^\]|]+?\.(?:jpg|png))\s*(?:\|(.*))?$",
                          fields.get(key, ""), re.M)
    card = {
        "name": fields.get("name", title).strip() or title,
        "faction": fields.get("faction", "").strip(),
        "rarity": fields.get("rarity", "").strip(),
        "set": fields.get("release", "").strip(),
        "types": [v.strip() for k in ("type1", "type2", "type3", "type4")
                  if (v := fields.get(k, "").strip())],
        "subtypes": [v.strip() for k in ("subtype1", "subtype2", "subtype3", "subtype4")
                     if (v := fields.get(k, "").strip())],
        "levels": [],
        "images": [img for img, _ in images("image")],
        "altImages": [img for img, _ in images("altimage1")],
    }
    for i in (1, 2, 3, 4):
        lvl = {"level": i,
               "text": fields.get(f"text{i}", "").strip(),
               "attack": fields.get(f"attack{i}", "").strip(),
               "health": fields.get(f"health{i}", "").strip()}
        if lvl["text"] or lvl["attack"] or lvl["health"]:
            card["levels"].append(lvl)
    return card


def cmd_data(*set_names):
    lists = json.load(open(os.path.join(BUILD, "cardlists.json")))
    os.makedirs(BUILD, exist_ok=True)
    for s in set_names:
        titles = lists[s]
        cards, skipped = [], []
        for n, t in enumerate(titles, 1):
            print(f"[{s}] {n}/{len(titles)} {t}", flush=True)
            wt = wikitext(t)
            card = parse_cardtable(t, wt) if wt else None
            if card:
                cards.append(card)
            else:
                skipped.append(t)
            time.sleep(DELAY)
        out = os.path.join(BUILD, f"cards_{s}.json")
        with open(out, "w") as f:
            json.dump({"set": s, "count": len(cards), "skipped": skipped,
                       "cards": cards}, f, indent=1, ensure_ascii=False)
        print(f"{s}: {len(cards)} cards parsed, skipped {skipped} -> {out}")


def image_url(filename):
    d = api({"action": "query", "titles": "File:" + filename,
             "prop": "imageinfo", "iiprop": "url", "format": "json"})
    for p in d["query"]["pages"].values():
        ii = p.get("imageinfo")
        if ii:
            return ii[0]["url"]
    return None


def cmd_images(*json_paths):
    os.makedirs(ASSETS, exist_ok=True)
    todo = []
    for p in json_paths:
        for c in json.load(open(p))["cards"]:
            for img in c["images"]:
                todo.append((c["name"], img))
    print(f"{len(todo)} images to fetch")
    for n, (card_name, img) in enumerate(todo, 1):
        safe = re.sub(r"[^\w\- ]", "_", card_name)
        dest_dir = os.path.join(ASSETS, safe)
        dest = os.path.join(dest_dir, img.split("/")[-1].replace("'", "_"))
        if os.path.exists(dest):
            continue
        os.makedirs(dest_dir, exist_ok=True)
        url = image_url(img)
        if not url:
            print(f"  NO URL: {img}", file=sys.stderr)
            continue
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
                f.write(r.read())
        except Exception as e:
            print(f"  FAIL {img}: {e}", file=sys.stderr)
        if n % 25 == 0:
            print(f"{n}/{len(todo)}", flush=True)
        time.sleep(DELAY)
    print("images done ->", ASSETS)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"list": cmd_list, "data": cmd_data, "images": cmd_images}[cmd](*args)
