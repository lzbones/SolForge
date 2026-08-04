#!/usr/bin/env python3
"""Validate scraped card JSON. Usage: python3 lint.py build/cards_Set_1.json ..."""
import json, sys
from collections import Counter

TOKENS = set()  # rarity == "Token" is allowed to have <3 levels / missing stats
problems = []

for path in sys.argv[1:]:
    d = json.load(open(path))
    cards = d["cards"]
    print(f"== {path}: {len(cards)} cards")
    print("   factions:", dict(Counter(c["faction"] for c in cards)))
    print("   rarities:", dict(Counter(c["rarity"] for c in cards)))
    print("   types:", dict(Counter("/".join(c["types"]) for c in cards)))
    for c in cards:
        n = c["name"]
        token = c["rarity"] == "Token"
        if not c["faction"] or not c["rarity"] or not c["set"]:
            problems.append(f"{n}: missing faction/rarity/set")
        if not token and len(c["levels"]) != 3:
            problems.append(f"{n}: has {len(c['levels'])} levels (expected 3)")
        if "Creature" in c["types"]:
            for l in c["levels"]:
                if not l["attack"] or not l["health"]:
                    problems.append(f"{n}: level {l['level']} missing attack/health"
                                    + (" [WIKI DATA GAP]" if not token else ""))
        if not c["images"]:
            problems.append(f"{n}: no images")
    dup = [k for k, v in Counter(c["name"] for c in cards).items() if v > 1]
    if dup:
        problems.append(f"duplicate names: {dup}")

print()
if problems:
    print(f"{len(problems)} problems:")
    for p in problems:
        print(" -", p)
else:
    print("ALL OK")
